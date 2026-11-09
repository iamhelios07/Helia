import type ts from 'typescript';

import standardLibrary from 'typescript/lib/lib.es5.d.ts?raw';

import type { SourceModule } from './code-authoring.js';

import { HELIA_AUTHORING_DECLARATIONS } from './authoring/runtime.js';
import { parseObjectSchema, type ValueSchema } from './state/schema.js';
const root = '/helia/';
const runtimePath = root + '.helia/runtime.d.ts';
type CompileError = (message: string, file: string, node: ts.Node) => never;
type Fail = (message: string) => never;
function createProgram(
	compiler: typeof ts,
	files: Record<string, SourceModule>,
	stateTypes: string
) {
	const sources = new Map(Object.entries(files).map(([path, file]) => [root + path, file.source]));
	sources.set(root + 'GameState.d.ts', stateTypes);
	sources.set(root + '.helia/lib.es5.d.ts', standardLibrary);
	sources.set(runtimePath, HELIA_AUTHORING_DECLARATIONS);
	const options: ts.CompilerOptions = {
		strict: true,
		exactOptionalPropertyTypes: true,
		noLib: true,
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

	return compiler.createProgram([...sources.keys()], options, host);
}
/** Materialize generic argument types before TypeScript erases them. Source is never evaluated. */
export function argumentSchemaCompiler(
	compiler: typeof ts,
	files: Record<string, SourceModule>,
	error: CompileError,
	stateTypes = 'export type GameState = Record<string, JsonValue>;'
): (path: string) => string {
	const materializer = new ArgumentMaterializer(
		compiler,
		files,
		error,
		createProgram(compiler, files, stateTypes)
	);
	return (path) => materializer.source(path);
}
class ArgumentMaterializer {
	readonly checker: ts.TypeChecker;
	readonly printer: ts.Printer;
	readonly diagnostics = new Map<ts.SourceFile, readonly ts.Diagnostic[]>();
	constructor(
		readonly compiler: typeof ts,
		readonly files: Record<string, SourceModule>,
		readonly error: CompileError,
		readonly program: ts.Program
	) {
		this.checker = program.getTypeChecker();
		this.printer = compiler.createPrinter();
	}
	expressionFor(value: unknown): ts.Expression {
		const factory = this.compiler.factory;
		if (value === null) {
			return factory.createNull();
		}
		if (typeof value === 'string') {
			return factory.createStringLiteral(value);
		}
		if (typeof value === 'boolean') {
			return value ? factory.createTrue() : factory.createFalse();
		}
		if (typeof value === 'number') {
			return value < 0
				? factory.createPrefixUnaryExpression(
						this.compiler.SyntaxKind.MinusToken,
						factory.createNumericLiteral(-value)
					)
				: factory.createNumericLiteral(value);
		}
		if (Array.isArray(value)) {
			return factory.createArrayLiteralExpression(value.map((item) => this.expressionFor(item)));
		}
		return factory.createObjectLiteralExpression(
			Object.entries(value as Record<string, unknown>).map(([key, item]) =>
				factory.createPropertyAssignment(factory.createStringLiteral(key), this.expressionFor(item))
			)
		);
	}
	registration(declaration: ts.Signature['declaration']) {
		return (
			declaration?.getSourceFile().fileName === runtimePath &&
			this.compiler.isMethodSignature(declaration) &&
			['defineAction', 'defineQuery'].includes(declaration.name.getText())
		);
	}
	validateInstantiation(node: ts.Node, path: string) {
		if (!this.compiler.isExpressionWithTypeArguments(node)) {
			return;
		}
		const registration = this.checker
			.getTypeAtLocation(node.expression)
			.getCallSignatures()
			.some((signature) => this.registration(signature.declaration));
		if (registration) {
			this.error(
				'인자 generic은 Action 또는 Query를 등록하는 호출에 직접 지정해주세요.',
				path,
				node
			);
		}
	}
	schema(node: ts.CallExpression, path: string) {
		const typeNode = node.typeArguments![0];
		const fail: Fail = (message) => this.error(message, path, typeNode);
		if (node.typeArguments!.length !== 1 || node.arguments.length !== 1) {
			fail('인자 타입 하나와 Action 또는 Query 정의 하나를 지정해주세요.');
		}
		if (this.checker.getTypeAtLocation(node.arguments[0]).getProperty('arguments')) {
			fail('generic 인자 타입과 arguments 스키마를 함께 지정할 수 없어요.');
		}
		const schema = new ArgumentTypeSchema(this, typeNode, fail).schemaFor(
			this.checker.getTypeFromTypeNode(typeNode)
		);
		if (schema.type !== 'object') {
			fail('Action과 Query의 인자 타입은 객체여야 해요.');
		}
		const validated = parseObjectSchema(schema);
		if (JSON.stringify(validated).length > 64 * 1024) {
			fail('인자 스키마가 너무 커요.');
		}
		return validated;
	}
	source(path: string) {
		const tree = this.program.getSourceFile(root + path)!;
		let changed = false;
		const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
			const visit: ts.Visitor = (node) => {
				this.validateInstantiation(node, path);
				if (
					this.compiler.isCallExpression(node) &&
					node.typeArguments?.length &&
					this.registration(this.checker.getResolvedSignature(node)?.declaration)
				) {
					const schema = this.schema(node, path);
					changed = true;
					return this.compiler.factory.updateCallExpression(
						node,
						node.expression,
						node.typeArguments,
						[
							this.compiler.factory.createObjectLiteralExpression(
								[
									this.compiler.factory.createSpreadAssignment(
										this.compiler.visitNode(node.arguments[0], visit) as ts.Expression
									),
									this.compiler.factory.createPropertyAssignment(
										'arguments',
										this.expressionFor(schema)
									)
								],
								true
							)
						]
					);
				}
				return this.compiler.visitEachChild(node, visit, context);
			};
			return (source) => this.compiler.visitNode(source, visit) as ts.SourceFile;
		};
		const output = this.compiler.transform(tree, [transformer]);
		try {
			return changed ? this.printer.printFile(output.transformed[0]) : this.files[path].source;
		} finally {
			output.dispose();
		}
	}
}
class ArgumentTypeSchema {
	remaining = 4096;
	readonly active = new Set<ts.Type>();
	readonly compiler: typeof ts;
	readonly checker: ts.TypeChecker;
	constructor(
		readonly materializer: ArgumentMaterializer,
		readonly typeNode: ts.TypeNode,
		readonly fail: Fail
	) {
		this.compiler = materializer.compiler;
		this.checker = materializer.checker;
	}
	unsupported(type: ts.Type): never {
		return this.fail(
			`인자 타입을 검증 스키마로 변환할 수 없어요: ${this.checker.typeToString(type)}. JSON으로 표현 가능한 유한한 타입을 사용해주세요.`
		);
	}
	checkDeclarations(type: ts.Type) {
		for (const declaration of [
			...(type.aliasSymbol?.declarations ?? []),
			...(type.symbol?.declarations ?? [])
		]) {
			const file = declaration.getSourceFile();
			if (file.fileName.startsWith(root + '.helia/')) {
				continue;
			}
			if (!this.materializer.diagnostics.has(file)) {
				this.materializer.diagnostics.set(
					file,
					this.materializer.program.getSemanticDiagnostics(file)
				);
			}
			const invalid = this.materializer.diagnostics
				.get(file)!
				.find(
					(item) =>
						item.category === this.compiler.DiagnosticCategory.Error &&
						item.start !== undefined &&
						item.start >= declaration.pos &&
						item.start < declaration.end
				);
			if (invalid) {
				this.fail(
					'인자 타입 정의를 확인해주세요: ' +
						this.compiler.flattenDiagnosticMessageText(invalid.messageText, '\n')
				);
			}
		}
	}
	primitive(type: ts.Type): ValueSchema | undefined {
		if (type.flags & this.compiler.TypeFlags.String) {
			return { type: 'string' };
		}
		if (type.flags & this.compiler.TypeFlags.Number) {
			return { type: 'number' };
		}
		if (type.flags & this.compiler.TypeFlags.Boolean) {
			return { type: 'boolean' };
		}
		if (type.flags & this.compiler.TypeFlags.Null) {
			return { type: 'null' };
		}
		if (type.isStringLiteral()) {
			return { type: 'string', enum: [type.value] };
		}
		if (type.isNumberLiteral()) {
			return { type: 'number', enum: [type.value] };
		}
		if (type.flags & this.compiler.TypeFlags.BooleanLiteral) {
			return { type: 'boolean', enum: [this.checker.typeToString(type) === 'true'] };
		}

		return undefined;
	}
	schemaFor(type: ts.Type, depth = 0): ValueSchema {
		if (--this.remaining < 0 || depth > 64) {
			this.fail('인자 타입이 너무 복잡해요.');
		}
		this.checkDeclarations(type);
		const primitive = this.primitive(type);
		if (primitive) {
			return primitive;
		}
		if (type.isUnion()) {
			return this.union(type, depth);
		}
		if (!this.objectType(type) || this.active.has(type)) {
			return this.unsupported(type);
		}
		this.active.add(type);
		try {
			return this.object(type, depth);
		} finally {
			this.active.delete(type);
		}
	}
	union(type: ts.UnionType, depth: number): ValueSchema {
		const parts = type.types.map((part) => this.schemaFor(part, depth + 1));
		const values = parts.filter((part) => part.type !== 'null');
		const nullable = values.length !== parts.length;
		if (!values.length) {
			return { type: 'null' };
		}
		let result = values[0];
		if (values.length > 1) {
			if (!values.every((part) => part.type === result.type && part.enum)) {
				this.unsupported(type);
			}
			result = { ...result, enum: values.flatMap((part) => part.enum!) };
		}
		if (nullable) {
			if (typeof result.type !== 'string' || result.type === 'null') {
				return this.unsupported(type);
			}
			result = {
				...result,
				type: [result.type, 'null'],
				...(result.enum ? { enum: [...result.enum, null] } : {})
			} as ValueSchema;
		}
		return result;
	}
	objectType(type: ts.Type): boolean {
		return (
			!!(type.flags & this.compiler.TypeFlags.Object) ||
			(type.isIntersection() && type.types.every((part) => this.objectType(part)))
		);
	}
	object(type: ts.Type, depth: number): ValueSchema {
		if (this.checker.isTupleType(type)) {
			return this.unsupported(type);
		}
		if (this.checker.isArrayType(type)) {
			return {
				type: 'array',
				items: this.schemaFor(this.checker.getTypeArguments(type as ts.TypeReference)[0], depth + 1)
			};
		}
		if (
			type.getCallSignatures().length ||
			type.getConstructSignatures().length ||
			this.checker.getIndexInfosOfType(type).length
		) {
			return this.unsupported(type);
		}
		return this.properties(type, depth);
	}
	properties(type: ts.Type, depth: number): ValueSchema {
		const properties: Record<string, ValueSchema> = {};
		const required: string[] = [];
		for (const property of type.getProperties()) {
			const name = property.getName();
			if (['__proto__', 'constructor', 'prototype'].includes(name) || name.startsWith('__@')) {
				return this.unsupported(type);
			}
			const field = this.schemaFor(
				this.checker.getTypeOfSymbolAtLocation(property, this.typeNode),
				depth + 1
			);
			const description = this.compiler.displayPartsToString(
				property.getDocumentationComment(this.checker)
			);
			properties[name] = { ...field, ...(description ? { description } : {}) };
			if (!(property.flags & this.compiler.SymbolFlags.Optional)) {
				required.push(name);
			}
		}
		return { type: 'object', properties, required, additionalProperties: false };
	}
}
