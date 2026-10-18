# @mockdata/cli

The mockdata command-line interface, part of [mockdata](https://github.com/leapbase/mockdata).

Provides schema validation, synthetic data generation, schema inference, and direct database seeding.

## Setup

Requires Node.js 22.13 or newer. These packages are currently developed together in the mockdata npm workspace. Clone the repository, then run from its root:

```sh
npm install
npm run build
```

## Usage

After building the repository, run:

```sh
npx mockdata --help
npx mockdata validate examples/shop.yaml
npx mockdata generate examples/shop.yaml
```

Database seeding previews changes by default; writing requires `--apply`. See the project guide for target configuration and safety checks.

## Documentation and source

- [Project guide and examples](https://github.com/leapbase/mockdata#readme)
- [Package source](https://github.com/leapbase/mockdata/tree/develop/packages/cli)
- [Issue tracker](https://github.com/leapbase/mockdata/issues)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full license text. The project permits use under version 3 or, at your option, any later version.
