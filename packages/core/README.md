# @mockdata/core

Deterministic synthetic data generation, part of [mockdata](https://github.com/leapbase/mockdata).

Validates schemas, orders related tables, generates seeded data, and checks constraints such as keys, references, uniqueness, and date ordering.

## Setup

Requires Node.js 22.13 or newer. These packages are currently developed together in the mockdata npm workspace. Clone the repository, then run from its root:

```sh
npm install
npm run build
```

## Usage

Use the `generate` and `parseSchema` exports in your application. Generation runs synchronously; model-written columns are handled by `@mockdata/llm`.

## Documentation and source

- [Project guide and examples](https://github.com/leapbase/mockdata#readme)
- [Package source](https://github.com/leapbase/mockdata/tree/develop/packages/core)
- [Issue tracker](https://github.com/leapbase/mockdata/issues)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full license text. The project permits use under version 3 or, at your option, any later version.
