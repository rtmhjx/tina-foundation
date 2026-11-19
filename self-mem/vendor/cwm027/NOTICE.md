# Third-party algorithm provenance

These three modules are transpiled from `cortico-world-memory` **0.2.7**, published by the upstream project at https://github.com/hth768/cortico-world-memory. The npm package declares the MIT license. Its published archive did not include a separate LICENSE or copyright notice; original source comments are retained. This notice does not claim ownership of the upstream work.

`PROVENANCE.json` records the exact npm archive, SHA-256 hashes of the original TypeScript files and generated modules, compiler version and the complete modification list. BM25, Chinese tokenization, cosine, the 0.3 cutoff, RRF and tie-breaking are unchanged. The only behavior addition is a `legacyIndex` field on public search results so identical text can retain distinct source references.

The migration adapter supplies a read-only in-memory backend. It does not construct the old World, start its runtime, migrate data, or invoke its writable filesystem backends. Legacy source records remain unchanged; invalid or unconfirmed vectors are excluded from the in-memory vector ranking only, with explicit diagnostics.

MIT license terms are reproduced in `LICENSE`.
