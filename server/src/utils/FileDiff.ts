import * as lsp from "vscode-languageserver"
import {Position} from "vscode-languageclient"

interface Edit {
    range: lsp.Range
    newText: string
}

/**
 * Utility class for building workspace edits
 */
export class FileDiff {
    private readonly edits: Edit[] = []

    private constructor(private readonly uri: string) {}

    /**
     * Create a new diff for a file
     */
    static forFile(uri: string): FileDiff {
        return new FileDiff(uri)
    }

    /**
     * Add text at the beginning of a line
     */
    appendToBegin(line: number, text: string): this {
        return this.appendTo({line, character: 0}, text)
    }

    /**
     * Add text at specific position
     */
    appendTo(pos: Position, text: string): this {
        this.edits.push({
            range: {start: pos, end: pos},
            newText: text,
        })
        return this
    }

    /**
     * Add text as a new line before specified line
     */
    appendAsPrevLine(line: number, text: string): this {
        const pos = {line, character: 0}
        this.edits.push({
            range: {start: pos, end: pos},
            newText: `${text}\n`,
        })
        return this
    }

    /**
     * Add text as a new line after specified line
     */
    appendAsNextLine(line: number, text: string): this {
        const pos = {line: line + 1, character: 0}
        this.edits.push({
            range: {start: pos, end: pos},
            newText: `${text}\n`,
        })
        return this
    }

    /**
     * Replace text in range
     */
    replace(range: lsp.Range, newText: string): this {
        this.edits.push({range, newText})
        return this
    }

    /**
     * Convert to LSP WorkspaceEdit
     */
    toWorkspaceEdit(): lsp.WorkspaceEdit {
        return {
            changes: {
                [this.uri]: this.toTextEdits(),
            },
        }
    }

    /**
     * Convert to array of TextEdit
     */
    toTextEdits(): lsp.TextEdit[] {
        return this.edits.map(edit => ({
            range: edit.range,
            newText: edit.newText,
        }))
    }

    /**
     * Get URI of the file being edited
     */
    getUri(): string {
        return this.uri
    }
}
