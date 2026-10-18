# @mockdata/inputs

Schema inference for mockdata, part of [mockdata](https://github.com/leapbase/mockdata).

Infers mockdata schemas from SQLite, PostgreSQL, MySQL/MariaDB, OpenAPI, JSON Schema, and sample data files.

## Setup

Requires Node.js 22.13 or newer. These packages are currently developed together in the mockdata npm workspace. Clone the repository, then run from its root:

```sh
npm install
npm run build
```

## Usage

Use the `inferFromSource` export for source detection and inference, or the format-specific exports for individual input types. See the project guide for supported formats and database configuration.

## Documentation and source

- [Project guide and examples](https://github.com/leapbase/mockdata#readme)
- [Package source](https://github.com/leapbase/mockdata/tree/develop/packages/inputs)
- [Issue tracker](https://github.com/leapbase/mockdata/issues)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full license text. The project permits use under version 3 or, at your option, any later version.
