# @mockdata/mcp

Model Context Protocol server for mockdata, part of [mockdata](https://github.com/leapbase/mockdata).

Exposes mockdata tools to MCP clients over stdio or Streamable HTTP, with workspace file confinement and configurable network access.

## Setup

Requires Node.js 22.13 or newer. These packages are currently developed together in the mockdata npm workspace. Clone the repository, then run from its root:

```sh
npm install
npm run build
```

## Usage

After building the repository, start the stdio server from the repository root:

```sh
MOCKDATA_ROOT="$PWD/examples" node packages/mcp/dist/bin.js
```

Add `--http` for the HTTP transport. See the project guide for client configuration and network access options.

## Documentation and source

- [Project guide and examples](https://github.com/leapbase/mockdata#readme)
- [Package source](https://github.com/leapbase/mockdata/tree/develop/packages/mcp)
- [Issue tracker](https://github.com/leapbase/mockdata/issues)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full license text. The project permits use under version 3 or, at your option, any later version.
