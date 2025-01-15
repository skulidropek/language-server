import * as lsp from 'vscode-languageserver';
import {
    FoldingRangeParams,
    ParameterInformation,
    ReferenceParams,
    RenameParams,
    SemanticTokens
} from 'vscode-languageserver';
import {connection} from './connection';
import {InitializeParams, TextDocumentSyncKind} from 'vscode-languageserver/node';
import {InitializeResult} from 'vscode-languageserver-protocol';
import {DocumentStore} from "./document-store";
import {readFileSync} from "fs";
import {createParser, initParser} from "./parser";
import {asLspRange, asParserPoint} from "./utils/position";
import {
    DocumentHighlight,
    DocumentHighlightKind,
    FoldingRange,
    InlayHint,
    Location,
    SignatureHelp
} from "vscode-languageserver-types";
import {TypeInferer} from "./TypeInferer";
import {SyntaxNode} from "web-tree-sitter";
import {NotificationFromServer} from "../../shared/src/shared-msgtypes";
import {Referent} from "./psi/Referent";
import {index} from "./indexes";
import {NamedNode} from "./psi/Node";
import {Reference} from "./psi/Reference";
import {File} from "./psi/File";
import * as docs from "./documentation/documentation";
import * as inlays from "./inlays/collect";
import * as foldings from "./foldings/collect";
import * as semantic from "./semantic_tokens/collect";
import {ReferenceCompletionProcessor} from "./completion/ReferenceCompletionProcessor";
import {CompletionContext} from "./completion/CompletionContext";

function getOffsetFromPosition(fileContent: string, line: number, column: number): number {
    const lines = fileContent.split('\n');
    if (line < 1 || line > lines.length) {
        return 0;
    }

    const targetLine = lines[line];
    if (column < 1 || column > targetLine.length + 1) {
        return 0;
    }

    let offset = 0;
    for (let i = 0; i < line; i++) {
        offset += lines[i].length + 1; // +1 for '\n'
    }
    offset += column - 1;
    return offset;
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    await initParser(params.initializationOptions.treeSitterWasmUri, params.initializationOptions.langWasmUri);

    const documents = new DocumentStore(connection);

    documents.onDidOpen(event => {
        console.log("open:", event.document.uri);

        const path = event.document.uri.substring(7);
        const tree = getTree(path)
        index.addFile(path, tree)
    });

    documents.onDidClose(event => {
        console.log("close:", event.document.uri);

        const path = event.document.uri.slice(7);
        index.removeFile(path)
    })

    documents.onDidChangeContent(event => {
        console.log("changed:", event.document.uri);

        const path = event.document.uri.slice(7);
        index.removeFile(path)

        const tree = getTree(path, event.document.getText())
        index.addFile(path, tree)
    })

    const getTree = (path: string, content?: string | undefined) => {
        const realContent = content ?? readFileSync(path).toString();
        const parser = createParser()
        return parser.parse(realContent);
    }

    connection.onRequest(lsp.HoverRequest.type, async (params: lsp.HoverParams): Promise<lsp.Hover | null> => {
        const path = params.textDocument.uri.slice(7)
        const tree = getTree(path)
        const cursorPosition = asParserPoint(params.position)
        const hoverNode = tree.rootNode.descendantForPosition(cursorPosition)

        const res = Reference.resolve(NamedNode.create(hoverNode, new File(path)))
        if (res === null) return {
            range: asLspRange(hoverNode),
            contents: {
                kind: 'plaintext',
                value: hoverNode.type
            }
        }

        const doc = docs.generateDocFor(res)
        if (doc === null) return null

        return {
            range: asLspRange(hoverNode),
            contents: {
                kind: 'markdown',
                value: doc
            },
        }
    })

    connection.onRequest(lsp.DefinitionRequest.type, async (params: lsp.DefinitionParams): Promise<lsp.Location[] | lsp.LocationLink[]> => {
        const uri = params.textDocument.uri;
        const path = uri.slice(7)
        const tree = getTree(path)

        const cursorPosition = asParserPoint(params.position)
        const hoverNode = tree.rootNode.descendantForPosition(cursorPosition)

        if (hoverNode.type !== 'identifier' && hoverNode.type !== 'type_identifier') {
            return []
        }

        const element = NamedNode.create(hoverNode, new File(path))
        const res = Reference.resolve(element)
        if (res === null) return []

        const ident = res.nameIdentifier();
        if (ident === null) return []

        return [{
            uri: res.file.uri,
            range: asLspRange(ident),
        }]
    })

    connection.onRequest(lsp.CompletionRequest.type, async (params: lsp.CompletionParams): Promise<lsp.CompletionItem[]> => {
        const uri = params.textDocument.uri;
        const path = uri.slice(7)
        const content = readFileSync(path).toString();
        const parser = createParser()

        const offset = getOffsetFromPosition(content, params.position.line, params.position.character + 1)
        const start = content.slice(0, offset)
        const end = content.slice(offset)

        // Let's say we want to get autocompletion in the following code:
        //
        //   fun foo(p: Builder) {
        //      p.
        //   } // ^ caret here
        //
        // Regular parsers, including those that can recover from errors, will not
        // be able to parse this code well enough for us to recognize this situation.
        // Some Language Servers try to do this, but they end up with a lot of
        // incomprehensible and complex code that doesn't work well.
        //
        // The approach we use is very simple, instead of parsing the code above,
        // we transform it into:
        //
        //    fun foo(p: Builder) {
        //       p.dummyIdentifier
        //    } // ^ caret here
        //
        // Which will be parsed without any problems now.
        //
        // Now that we have valid code, we can use `Reference.processResolveVariants`
        // to resolve `dummyIdentifier` into a list of possible variants, which will
        // become the autocompletion list. See `Reference` class documentation.
        const newContent = `${start}dummyIdentifier${end}`
        const tree = parser.parse(newContent);

        const cursorPosition = asParserPoint(params.position)
        const hoverNode = tree.rootNode.descendantForPosition(cursorPosition)
        if (hoverNode.type !== 'identifier' && hoverNode.type !== 'type_identifier') {
            return []
        }

        const element = new NamedNode(hoverNode, new File(path))
        const ref = new Reference(element)

        const ctx = new CompletionContext(element, params.position, params.context?.triggerKind ?? lsp.CompletionTriggerKind.Invoked)

        const processor = new ReferenceCompletionProcessor(ctx);
        ref.processResolveVariants(processor)

        return Array.from(processor.result.values())
    });

    connection.onRequest(lsp.InlayHintRequest.type, async (params: lsp.InlayHintParams): Promise<InlayHint[] | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)
        return inlays.collect(tree, path)
    })

    const renameHandler = async (params: RenameParams): Promise<lsp.WorkspaceEdit | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)

        const cursorPosition = asParserPoint(params.position)
        const renameNode = tree.rootNode.descendantForPosition(cursorPosition)

        if (renameNode.type !== 'identifier') {
            return Promise.reject("not an identifier")
        }

        const result = new Referent(renameNode, path, tree).findReferences(true)
        if (result.length === 0) return Promise.reject("cannot find any references")

        return {
            changes: {
                [uri]: result.map(a => ({
                    range: asLspRange(a),
                    newText: params.newName
                }))
            }
        }
    };
    connection.onRequest(lsp.RenameRequest.type, (params: RenameParams) => renameHandler(params).catch(reason => {
        connection.sendNotification(NotificationFromServer.showErrorMessage, `Can not rename: ${reason}`).catch(console.error)
        return {}
    }))

    connection.onRequest(lsp.DocumentHighlightRequest.type, async (params: lsp.DocumentHighlightParams): Promise<DocumentHighlight[] | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)

        const cursorPosition = asParserPoint(params.position)
        const highlightNode = tree.rootNode.descendantForPosition(cursorPosition)

        if (highlightNode.type !== 'identifier' && highlightNode.type !== 'type_identifier') {
            return []
        }

        const result = new Referent(highlightNode, path, tree).findReferences(true)
        if (result.length === 0) return null

        return result.map(value => {
            let kind: DocumentHighlightKind = DocumentHighlightKind.Read
            const parent = value.parent!
            if (parent.type === 'assignment_statement') {
                if (parent.childForFieldName('left')!.equals(value)) {
                    // left = 10
                    // ^^^^
                    kind = DocumentHighlightKind.Write
                }
            }

            return {
                range: asLspRange(value),
                kind: kind
            }
        })
    })

    connection.onRequest(lsp.ReferencesRequest.type, async (params: ReferenceParams): Promise<Location[] | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)

        const cursorPosition = asParserPoint(params.position)
        const referenceNode = tree.rootNode.descendantForPosition(cursorPosition)

        if (referenceNode.type !== 'identifier' && referenceNode.type !== 'type_identifier') {
            return []
        }

        const result = new Referent(referenceNode, path, tree).findReferences(false)
        if (result.length === 0) return null

        return result.map(value => ({
            uri: uri,
            range: asLspRange(value)
        }))
    })

    connection.onRequest(lsp.SignatureHelpRequest.type, async (params: lsp.SignatureHelpParams): Promise<SignatureHelp | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)

        const cursorPosition = asParserPoint(params.position)
        const hoverNode = tree.rootNode.descendantForPosition(cursorPosition)
        const call = parentOfType(hoverNode, 'static_call_expression')
        if (!call) return null

        const nameNode = call.childForFieldName('name')
        if (!nameNode) return null

        const element = new NamedNode(nameNode, new File(path))
        const res = Reference.resolve(element)
        if (res === null) return null

        const parametersNode = res.node.childForFieldName('parameters')
        if (!parametersNode) return null

        const parameters = parametersNode.children.filter(value => value.type == 'parameter')

        // The algorithm below uses the positions of commas and parentheses to findTo find the active parameter, it is enough to find the last comma, which has a position in the line less than the cursor position. In order not to complicate the algorithm, we consider the opening bracket as a kind of comma for the zero element. If the cursor position is greater than the position of any comma, then we consider that this is the last element. the active parameter.
        //
        // foo(1000, 2000, 3000)
        //    ^    ^     ^
        //    |    |     |______ argsCommas
        //    |    |____________|
        //    |_________________|
        //
        // To find the active parameter, it is enough to find the last comma, which has a position in
        // the line less than the cursor position. To simplify the algorithm, we consider the opening
        // bracket as a kind of comma for the zero element.
        // If the cursor position is greater than the position of any comma, then we consider that this
        // is the last parameter.
        //
        // TODO: support multiline calls and functions with self

        const rawArguments = call.childForFieldName('arguments')!;
        const argsCommas = rawArguments.children.filter(value => value.text === ',' || value.text === '(')

        let currentIndex = 0
        for (const [i, argComma] of argsCommas.entries()) {
            if (argComma.endPosition.column > params.position.character) {
                // found comma after cursor
                break
            }
            currentIndex = i
        }

        const parametersInfo: ParameterInformation[] = parameters.map(value => ({
            label: value.text,
        }))
        const parametersString = parametersInfo.map(el => el.label).join(', ')

        return {
            signatures: [
                {
                    label: `fun ${nameNode.text}(${parametersString})`,
                    parameters: parametersInfo,
                    activeParameter: currentIndex
                }
            ],
        }
    });

    connection.onRequest(lsp.FoldingRangeRequest.type, async (params: FoldingRangeParams): Promise<FoldingRange[] | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)
        return foldings.collect(tree)
    })

    connection.onRequest(lsp.SemanticTokensRequest.type, async (params: lsp.SemanticTokensParams): Promise<SemanticTokens | null> => {
        const uri = params.textDocument.uri;
        const path = uri.substring(7)
        const tree = getTree(path)
        return semantic.collect(tree, path)
    })

    const _ = TypeInferer.inferType;

    console.log('Tact language server is ready!');

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // codeActionProvider: true,
            // documentSymbolProvider: true,
            definitionProvider: true,
            renameProvider: true,
            hoverProvider: true,
            inlayHintProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            foldingRangeProvider: true,
            // documentFormattingProvider: true,
            completionProvider: {
                triggerCharacters: ['.']
            },
            signatureHelpProvider: {
                triggerCharacters: ['(', ','],
                retriggerCharacters: [',', ' '],
            },
            semanticTokensProvider: {
                legend: {
                    tokenTypes: Object.keys(lsp.SemanticTokenTypes),
                    tokenModifiers: Object.keys(lsp.SemanticTokenModifiers),
                },
                range: false,
                full: true,
            }
        }
    }
})

function parentOfType(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
    let parent = node.parent

    while (true) {
        if (parent === null) return null
        if (types.includes(parent.type)) return parent
        parent = parent.parent
    }
}

connection.listen();
