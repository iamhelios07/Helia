import type ts from 'typescript';
import standardLibrary from 'typescript/lib/lib.es5.d.ts?raw';
import { HELIA_AUTHORING_DECLARATIONS, type SourceModule } from './code-authoring.js';
import { parseObjectSchema, type ValueSchema } from './state/schema.js';

// The compiler host reads only these virtual files, never the host filesystem or network.
const root = '/helia/';
const runtimePath = root + '.helia/runtime.d.ts';

/** Materialize generic argument types before TypeScript erases them. Source is never evaluated. */
export function argumentSchemaCompiler(
	compiler: typeof ts,
	files: Record<string, SourceModule>,
	error: (message: string, file: string, node: ts.Node) => never,
	stateTypes = 'export type GameState = Record<string, JsonValue>;'
): (path: string) => string {
	const sources = new Map(Object.entries(files).map(([path, file]) => [root + path, file.source]));
	sources.set(root + 'GameState.d.ts', stateTypes);
	sources.set(root + '.helia/lib.es5.d.ts', standardLibrary);
	sources.set(
		runtimePath,
		HELIA_AUTHORING_DECLARATIONS.replaceAll("'./GameState'", "'../GameState'") +
			"\ndeclare module '@helia/state' { export type GameState = import('../GameState').GameState; }"
	);
	const options: ts.CompilerOptions = {
		strict: true,
		exactOptionalPropertyTypes: true,
		noLib: true,
		allowJs: true,
		target: compiler.ScriptTarget.ES2022,
		module: compiler.ModuleKind.ESNext,
		moduleResolution: compiler.ModuleResolutionKind.Node10
	};
	const host: ts.CompilerHost = {
		getSourceFile: (path, target) => {
			const source = sources.get(path);
			return source === undefined
				? undefined
				: compiler.createSourceFile(path, source, target, true);
		},
		getDefaultLibFileName: () => root + '.helia/lib.es5.d.ts',
		writeFile: () => {},
		getCurrentDirectory: () => root.slice(0, -1),
		getCanonicalFileName: (path) => path,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
		fileExists: (path) => sources.has(path),
		readFile: (path) => sources.get(path),
		directoryExists: (path) => [...sources.keys()].some((file) => file.startsWith(path + '/'))
	};
	const program = compiler.createProgram([...sources.keys()], options, host);
	const checker = program.getTypeChecker();
	const printer = compiler.createPrinter();
	const diagnostics = new Map<ts.SourceFile, readonly ts.Diagnostic[]>();
	const expressionFor = (value: unknown): ts.Expression => {
		const factory = compiler.factory;
		if (value === null) return factory.createNull();
		if (typeof value === 'string') return factory.createStringLiteral(value);
		if (typeof value === 'boolean') return value ? factory.createTrue() : factory.createFalse();
		if (typeof value === 'number')
			return value < 0
				? factory.createPrefixUnaryExpression(
						compiler.SyntaxKind.MinusToken,
						factory.createNumericLiteral(-value)
					)
				: factory.createNumericLiteral(value);
		if (Array.isArray(value)) return factory.createArrayLiteralExpression(value.map(expressionFor));
		return factory.createObjectLiteralExpression(
			Object.entries(value as Record<string, unknown>).map(([key, item]) =>
				factory.createPropertyAssignment(factory.createStringLiteral(key), expressionFor(item))
			)
		);
	};
	return (path) => {
		const tree = program.getSourceFile(root + path)!;
		let changed = false;
		const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
			const visit: ts.Visitor = (node) => {
				if (
					compiler.isExpressionWithTypeArguments(node) &&
					checker
						.getTypeAtLocation(node.expression)
						.getCallSignatures()
						.some((signature) => {
							const declaration = signature.declaration;
							return (
								declaration?.getSourceFile().fileName === runtimePath &&
								compiler.isMethodSignature(declaration) &&
								['defineAction', 'defineQuery'].includes(declaration.name.getText())
							);
						})
				)
					error(
						'인자 generic은 Action 또는 Query를 등록하는 호출에 직접 지정해주세요.',
						path,
						node
					);
				if (compiler.isCallExpression(node) && node.typeArguments?.length) {
					const declaration = checker.getResolvedSignature(node)?.declaration;
					if (
						declaration?.getSourceFile().fileName === runtimePath &&
						compiler.isMethodSignature(declaration) &&
						['defineAction', 'defineQuery'].includes(declaration.name.getText())
					) {
						const typeNode = node.typeArguments[0];
						const fail = (message: string): never => error(message, path, typeNode);
						if (node.typeArguments.length !== 1 || node.arguments.length !== 1)
							fail('인자 타입 하나와 Action 또는 Query 정의 하나를 지정해주세요.');
						if (checker.getTypeAtLocation(node.arguments[0]).getProperty('arguments'))
							fail('generic 인자 타입과 arguments 스키마를 함께 지정할 수 없어요.');
						const type = checker.getTypeFromTypeNode(node.typeArguments[0]);
						let remaining = 4096;
						const active = new Set<ts.Type>();
						const schemaFor = (type: ts.Type, depth = 0): ValueSchema => {
							const unsupported = (): never =>
								fail(
									`인자 타입을 검증 스키마로 변환할 수 없어요: ${checker.typeToString(type)}. JSON으로 표현 가능한 유한한 타입을 사용해주세요.`
								);
							if (--remaining < 0 || depth > 64) fail('인자 타입이 너무 복잡해요.');
							for (const declaration of [
								...(type.aliasSymbol?.declarations ?? []),
								...(type.symbol?.declarations ?? [])
							]) {
								const file = declaration.getSourceFile();
								if (file.fileName.startsWith(root + '.helia/')) continue;
								if (!diagnostics.has(file))
									diagnostics.set(file, program.getSemanticDiagnostics(file));
								const invalid = diagnostics
									.get(file)!
									.find(
										(item) =>
											item.category === compiler.DiagnosticCategory.Error &&
											item.start !== undefined &&
											item.start >= declaration.pos &&
											item.start < declaration.end
									);
								if (invalid)
									fail(
										'인자 타입 정의를 확인해주세요: ' +
											compiler.flattenDiagnosticMessageText(invalid.messageText, '\n')
									);
							}
							if (type.flags & compiler.TypeFlags.String) return { type: 'string' };
							if (type.flags & compiler.TypeFlags.Number) return { type: 'number' };
							if (type.flags & compiler.TypeFlags.Boolean) return { type: 'boolean' };
							if (type.flags & compiler.TypeFlags.Null) return { type: 'null' };
							if (type.isStringLiteral()) return { type: 'string', enum: [type.value] };
							if (type.isNumberLiteral()) return { type: 'number', enum: [type.value] };
							if (type.flags & compiler.TypeFlags.BooleanLiteral)
								return { type: 'boolean', enum: [checker.typeToString(type) === 'true'] };
							if (type.isUnion()) {
								const parts = type.types.map((part) => schemaFor(part, depth + 1));
								const values = parts.filter((part) => part.type !== 'null');
								const nullable = values.length !== parts.length;
								if (!values.length) return { type: 'null' };
								let result = values[0];
								if (values.length > 1) {
									if (!values.every((part) => part.type === result.type && part.enum))
										unsupported();
									result = { ...result, enum: values.flatMap((part) => part.enum!) };
								}
								if (nullable) {
									if (typeof result.type !== 'string' || result.type === 'null')
										return unsupported();
									result = {
										...result,
										type: [result.type, 'null'],
										...(result.enum ? { enum: [...result.enum, null] } : {})
									} as ValueSchema;
								}
								return result;
							}
							const objectType = (part: ts.Type): boolean =>
								!!(part.flags & compiler.TypeFlags.Object) ||
								(part.isIntersection() && part.types.every(objectType));
							if (!objectType(type) || active.has(type)) return unsupported();
							active.add(type);
							try {
								if (checker.isTupleType(type)) return unsupported();
								if (checker.isArrayType(type)) {
									return {
										type: 'array',
										items: schemaFor(
											checker.getTypeArguments(type as ts.TypeReference)[0],
											depth + 1
										)
									};
								}
								if (
									type.getCallSignatures().length ||
									type.getConstructSignatures().length ||
									checker.getIndexInfosOfType(type).length
								)
									return unsupported();
								const properties: Record<string, ValueSchema> = {};
								const required: string[] = [];
								for (const property of type.getProperties()) {
									const name = property.getName();
									if (
										['__proto__', 'constructor', 'prototype'].includes(name) ||
										name.startsWith('__@')
									)
										return unsupported();
									const field = schemaFor(
										checker.getTypeOfSymbolAtLocation(property, typeNode),
										depth + 1
									);
									const description = compiler.displayPartsToString(
										property.getDocumentationComment(checker)
									);
									properties[name] = { ...field, ...(description ? { description } : {}) };
									if (!(property.flags & compiler.SymbolFlags.Optional)) required.push(name);
								}
								return { type: 'object', properties, required, additionalProperties: false };
							} finally {
								active.delete(type);
							}
						};
						const schema = schemaFor(type);
						if (schema.type !== 'object') fail('Action과 Query의 인자 타입은 객체여야 해요.');
						const validated = parseObjectSchema(schema);
						const json = JSON.stringify(validated);
						if (json.length > 64 * 1024) fail('인자 스키마가 너무 커요.');
						changed = true;
						return compiler.factory.updateCallExpression(
							node,
							node.expression,
							node.typeArguments,
							[
								compiler.factory.createObjectLiteralExpression(
									[
										compiler.factory.createSpreadAssignment(
											compiler.visitNode(node.arguments[0], visit) as ts.Expression
										),
										compiler.factory.createPropertyAssignment('arguments', expressionFor(validated))
									],
									true
								)
							]
						);
					}
				}
				return compiler.visitEachChild(node, visit, context);
			};
			return (source) => compiler.visitNode(source, visit) as ts.SourceFile;
		};
		const output = compiler.transform(tree, [transformer]);
		try {
			return changed ? printer.printFile(output.transformed[0]) : files[path].source;
		} finally {
			output.dispose();
		}
	};
}
