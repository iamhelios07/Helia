# CBS templates

Helia implements a read-only subset inspired by [RisuAI CBS](https://github.com/kwaroran/RisuAI/blob/7be37f64fce428868559963db3e966ade1808f1c/src/ts/cbs.ts). There is no variable store or JavaScript evaluation. State writes remain Actions and Transactions.

## Where to write templates

Use CBS in Settings → Prompts block text, formatting, author-note defaults, trailing instructions and assistant prefill; the game editor's AI instructions, author note and active lorebook entry content; and Settings → Personas descriptions. Disabled or unused content is not evaluated. ChatML roles are parsed before its authored message bodies are expanded.

Chat messages, including the opening, user messages and saved AI output, expand CBS for display and in request copies. Composer and authoring inputs retain the original syntax, as do saved messages. Display applies display-stage regex → CBS → Markdown/HTML; requests apply request-stage regex → CBS to chat text. Regex replacements can therefore introduce CBS. Names and state reads in the visible conversation follow the currently selected persona and branch state, including after checkout or refresh. History previews, generation progress and editor playthrough dialogue use the same contextual message renderer. A display error affects only that message and shows a diagnostic rather than raw source.

Memories, native tool-turn transcripts, tool results and structured state/transaction summaries remain literal data. Creator code is not a CBS template. Lookup values and inserted slots cannot introduce another template evaluation; use `#escape` to show literal CBS syntax in dialogue. Lorebook activation still uses request-stage chat text, before CBS expansion.

```text
게임: {{game}}
플레이어: {{user}}
설명: {{persona}}
소지금: {{state::gold}}G
철 재고: {{state::inventory::iron}}

{{#when::{{state::phase}}::is::night_shop}}
야간 상점이다. 내일의 소문과 재고를 고려한다.
{{:else}}
현재 손님의 주문에 집중한다.
{{/when}}
```

Game title, selected preset and resolved persona are captured for an invocation. Before every tool-follow-up model request, templates and prefill read the updated temporary state. Successful final validation and commit are still required; a CBS error after a tool call does not commit that temporary state. Rendering never rewrites authored source or history.

## References

| Expression                          | Result                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `{{state}}`                         | Complete current state as JSON                                            |
| `{{state::inventory::iron}}`        | Own-property path segments, with zero-based array indexes when applicable |
| `{{game}}`                          | Game title; this is a Helia expression                                    |
| `{{user}}`                          | Bound/current persona name, or `플레이어`                                 |
| `{{persona}}`, `{{userpersona}}`    | Selected persona description, with CBS expansion                          |
| `{{description}}`                   | Game AI instructions, with CBS expansion                                  |
| `{{authornote}}`, `{{author_note}}` | Game author note, with CBS expansion                                      |
| `{{slot}}`                          | Inserted content inside `innerFormat`; preserved literally elsewhere      |

Strings are emitted unchanged; numbers/booleans, arrays and objects use JSON notation. Missing values and JSON null become `null`, while `0`, `false` and the empty string keep their values. A dot in a state path segment is a literal character, not a path separator. Prototype traversal is rejected. Persona names, game titles, state values and slots are never reparsed. Authored description/persona/note references may refer to each other, but self/cyclic references fail.

## Functions

`{{function::argument::argument}}` supports nested expressions. Function names are case-insensitive and ignore `_` and `-`; block names and condition operators use the lowercase spellings below. Arguments retain whitespace. Top-level `::` separates arguments; balanced JSON objects/arrays retain their internal delimiters. Quotes alone do not escape a top-level delimiter. Use `#escape` to supply arbitrary literal template syntax as an argument.

| Group              | Functions                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Comparison         | `equal`, `notequal`, `greater`, `less`, `greaterequal`, `lessequal`                                         |
| Logic              | `and`, `or` (two or more arguments), `not`                                                                  |
| Math               | `calc`, `round`, `floor`, `ceil`, `abs`                                                                     |
| Text               | `trim`, `replace`, `contains`, `startswith`, `endswith`, `length`, `lower`, `upper`                         |
| Arrays/objects     | `makearray` (`array`, `a`), `split`, `join`, `arraylength`, `arrayelement`, `dictelement` (`objectelement`) |
| Literal characters | `br` (newline), `cbr` (literal `\n`), `blank`, `bo` (`{{`), `bc` (`}}`)                                     |

```text
{{floor::{{calc::(26+20)*1.2}}}}
{{join::{{makearray::검::방패}}::, }}
{{dictelement::{{arrayelement::{{state::items}}::0}}::name}}
{{replace::banana::a::o}}
```

- Comparison and logic return `1` or `0`. Equality compares strings exactly (`01` differs from `1`); numeric comparisons require finite numbers. Both logic functions and conditions treat exactly `1` and `true` as true, including serialized state booleans.
- `calc` (also `{{? 2+3}}`) supports decimal/scientific numbers, parentheses, unary signs and `+ - * / % ^`. Exponentiation is right-associative and precedes unary signs: `2^3^2 = 512`, `-2^2 = -4`. Invalid/non-finite results fail. There are no identifiers, variable shortcuts or executable code.
- Text operations are case-sensitive; `replace` replaces all literal occurrences and inserts replacement text literally (including `$`). `length` counts UTF-16 code units. Case conversion is locale-independent.
- `makearray` creates a JSON array of string arguments; `split` and array reads consume/produce JSON. `arrayelement` is zero-based and supports negative indexes. Out-of-range reads return `null`. `join` renders nested objects/arrays as JSON and null as `null`.

## Blocks

`{{#when CONDITION}}...{{:else}}...{{/when}}` and `{{#when::CONDITION}}...{{/when}}` support nesting. Only the selected branch is evaluated. `:else` may be inline or on its own line. `{{/}}` also closes the current conditional.

Operators are `not`, `and`, `or`, `is`, `isnot`, `>`, `<`, `>=`, `<=`. Comparisons bind before `not`, followed by `and` then `or`. For complex conditions, nested comparison/logic functions can make grouping explicit. The default removes leading/trailing blank lines while preserving indentation. Prefix `keep` preserves all whitespace.

```text
{{#when::keep::{{state::gold}}::>=::30::and::{{state::inventory::iron}}::>::0}}
미스릴을 구매할 여유가 있다.
{{/when}}

{{#escape::keep}}Here is literal syntax: {{state::gold}}{{/escape}}
```

`#escape` returns its body without evaluating nested expressions and trims outer whitespace; `#escape::keep` preserves it. Escaped output is not reparsed.

## Compatibility and limits

This is a documented subset, not full Risu compatibility. Unlike Risu's current parser, conditional branches are lazy, logic consistently accepts state `true`, and inserted data is not reparsed. Arithmetic uses the precedence described above rather than Risu's legacy calculator quirks. Literal replacement and JSON-aware argument boundaries also follow the rules above.

Unknown function expressions remain unchanged without evaluating their arguments, including excluded `char`, `bot`, `getvar` and mutation macros. Unsupported blocks (including `#if`, `#each`, `#func`), malformed syntax and invalid supported expressions fail with a `CBS:` diagnostic. `personality`/`charpersona`, `scenario`, example-dialogue aliases, global/temporary variables, random/dice/time/history helpers and Risu UI/assets are not implemented. Canonical brace syntax is used; `<user>`/`<char>` legacy replacements are not implemented.

Limits bound each source (512Ki characters), output (2Mi characters), nesting (32), parsed nodes (10,000), evaluation steps per renderer (20,000), arguments (256), JSON array entries (10,000) and calculator complexity. Expanded prompts must also fit the preset's context limit. Oversized replacement/join expansion is rejected before allocating the combined string.
