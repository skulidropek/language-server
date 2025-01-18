import {Contract, Trait} from "../psi/TopLevelDeclarations"
import {index, IndexKey} from "../indexes"
import {ResolveState, ScopeProcessor} from "../psi/Reference"
import {Node} from "../psi/Node"

export function implementations(trait: Trait): (Contract | Trait)[] {
    const result: (Contract | Trait)[] = []

    const s = new ResolveState()
    index.processElementsByKey(IndexKey.Contracts, new ImplementationProcessor(trait, result), s)
    index.processElementsByKey(IndexKey.Traits, new ImplementationProcessor(trait, result), s)

    return result
}

class ImplementationProcessor implements ScopeProcessor {
    public constructor(
        public trait: Trait,
        public result: (Contract | Trait)[],
    ) {}

    execute(node: Node, _state: ResolveState): boolean {
        if (!(node instanceof Trait) && !(node instanceof Contract)) return true

        const inheritsFromTrait = node
            .inheritTraits()
            .some(inheritTrait => inheritTrait.name() === this.trait.name())

        if (inheritsFromTrait) {
            this.result.push(node)
        }

        return true
    }
}
