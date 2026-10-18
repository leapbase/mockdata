# @mockdata/server

Local web server for mockdata, part of [mockdata](https://github.com/leapbase/mockdata).

Serves the mockdata browser workspace and API, with optional hooks for an embedding application through `HostedPlugin`.

## Setup

Requires Node.js 22.13 or newer. These packages are currently developed together in the mockdata npm workspace. Clone the repository, then run from its root:

```sh
npm install
npm run build
```

## Usage

After building the full repository, start the UI from the repository root:

```sh
npm run ui -- examples
```

The UI requires the built assets from `packages/web/dist`; this package alone does not bundle those assets. Applications can also use the `createApp` and `startServer` exports.

## Documentation and source

- [Project guide and examples](https://github.com/leapbase/mockdata#readme)
- [Package source](https://github.com/leapbase/mockdata/tree/develop/packages/server)
- [Issue tracker](https://github.com/leapbase/mockdata/issues)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full license text. The project permits use under version 3 or, at your option, any later version.
