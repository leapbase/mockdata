# @mockdata/llm

Model-assisted synthetic data generation, part of [mockdata](https://github.com/leapbase/mockdata).

Fills semantic text columns using Anthropic, OpenAI, Ollama, or an OpenAI-compatible provider while `@mockdata/core` generates the remaining data.

## Setup

Requires Node.js 22.13 or newer. These packages are currently developed together in the mockdata npm workspace. Clone the repository, then run from its root:

```sh
npm install
npm run build
```

## Usage

Use the `generateWithLlm` export. Configure the provider, model, and credentials as described in the project guide. Only columns marked `llm` are sent for model generation.

## Documentation and source

- [Project guide and examples](https://github.com/leapbase/mockdata#readme)
- [Package source](https://github.com/leapbase/mockdata/tree/develop/packages/llm)
- [Issue tracker](https://github.com/leapbase/mockdata/issues)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full license text. The project permits use under version 3 or, at your option, any later version.
