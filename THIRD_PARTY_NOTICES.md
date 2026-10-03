# Third-party notices

## Obsidian Local REST API

Obsidian Server MCP references and adapts API contracts and implementation
patterns from [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
by Adam Coddington. The compatibility reference is version **5.3.1**, commit
`17a9cfd9ff5dd0156b694bf9b13ab36c786b29da`.

The corresponding upstream sources include `src/mcpHandler.ts` and
`src/vaultOperations.ts`. Their tool schemas, document/patch/query semantics,
text classification and path-operation behavior informed this implementation.
The filesystem backend has its own containment, version and mutation rules;
see [the compatibility tables](docs/local-rest-5.3.1-parity.md) for differences.

The following upstream notice is retained for copied or adapted portions.
It is reproduced from the [license at the pinned commit](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/17a9cfd9ff5dd0156b694bf9b13ab36c786b29da/LICENSE).

```text
MIT License

Copyright (c) 2023, Adam Coddington

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Installed dependencies

Dependencies are installed from `package-lock.json`; this source distribution
does not vendor their packages or native binaries. Each dependency retains its
own license and copyright notices in the installed package. Preserve those
notices when redistributing dependencies or a bundled build.
