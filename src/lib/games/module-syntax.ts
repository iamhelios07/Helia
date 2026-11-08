import type ts from 'typescript';

/** Type-only imports/re-exports never add a runtime dependency or cross a runtime boundary. */
export function isTypeOnlyModule(compiler: typeof ts, node: ts.Node): boolean {
	if (compiler.isImportDeclaration(node)) {
		const clause = node.importClause;
		return (
			!!clause &&
			(clause.isTypeOnly ||
				(!clause.name &&
					!!clause.namedBindings &&
					compiler.isNamedImports(clause.namedBindings) &&
					clause.namedBindings.elements.length > 0 &&
					clause.namedBindings.elements.every((item) => item.isTypeOnly)))
		);
	}
	return (
		compiler.isExportDeclaration(node) &&
		(node.isTypeOnly ||
			(!!node.exportClause &&
				compiler.isNamedExports(node.exportClause) &&
				node.exportClause.elements.length > 0 &&
				node.exportClause.elements.every((item) => item.isTypeOnly)))
	);
}
