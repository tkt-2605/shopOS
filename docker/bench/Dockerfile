# One till: the Node half that holds the database and the protocol, and the Rust
# half that holds the sockets. Both are the same code Layer 1 runs — see
# `docs/specs/test-bench-spec.md` for why a second implementation for containers
# would defeat the point.

FROM rust:1.83-bookworm AS net
WORKDIR /build
# The workspace root manifest is deliberately **not** copied. It names the Tauri
# app as a member, and cargo resolves every member's dependencies before it
# builds one — which here would mean pulling in tauri, webkit and the Windows
# crates to build a binary that needs none of them. Without a parent manifest
# `shopos-net` is simply its own package, which is what it is.
COPY crates/shopos-net ./shopos-net
RUN cargo build --release --manifest-path shopos-net/Cargo.toml

FROM node:22-bookworm
WORKDIR /shopos

# better-sqlite3 is built from source for this platform; the toolchain goes
# first so a change to the lockfile does not also rebuild it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/pos/package.json ./apps/pos/
COPY tools/virtual-till/package.json ./tools/virtual-till/
RUN npm ci --ignore-scripts=false

COPY packages ./packages
COPY tools ./tools
COPY tsconfig.base.json ./

COPY --from=net /build/shopos-net/target/release/shopos-net /usr/local/bin/shopos-net

COPY docker/bench/till.sh /usr/local/bin/till
RUN chmod +x /usr/local/bin/till

# 7801 is answered by shopos-net, which forwards to the Node till on 7803.
# 7802/udp is the shout. Only the first is what another till connects to.
EXPOSE 7801 7802/udp
ENTRYPOINT ["/usr/local/bin/till"]
