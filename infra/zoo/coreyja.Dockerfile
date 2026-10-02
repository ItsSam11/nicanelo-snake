FROM rust:1.90-bookworm AS build

ARG COREYJA_COMMIT=d3a9bed45789f00918ea25df6025ed4e01462ae3

RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake git protobuf-compiler \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init \
  && git remote add origin https://github.com/coreyja/battlesnake-rs.git \
  && git fetch --depth 1 origin "${COREYJA_COMMIT}" \
  && git checkout --detach FETCH_HEAD

COPY infra/zoo/coreyja-hobbs-terminal.patch /tmp/coreyja-hobbs-terminal.patch
RUN git apply --check /tmp/coreyja-hobbs-terminal.patch \
  && git apply /tmp/coreyja-hobbs-terminal.patch \
  && cargo build --release --locked --bin web-axum

FROM debian:bookworm-slim

WORKDIR /app
COPY --from=build /src/target/release/web-axum /app/web-axum

ENV JSON_LOGS=1
ENV PORT=8200
EXPOSE 8200

ENTRYPOINT ["/app/web-axum"]
