FROM rust:1.88-bookworm AS build

ARG SNORK_COMMIT=76bec0c9c76b31b209fbeb8e409bb3e4c9133eb2

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init \
  && git remote add origin https://github.com/wrenger/snork.git \
  && git fetch --depth 1 origin "${SNORK_COMMIT}" \
  && git checkout --detach FETCH_HEAD \
  && cargo build --release --bin server

FROM debian:bookworm-slim

COPY --from=build /src/target/release/server /usr/local/bin/snork-server

ENV RUST_LOG=error
EXPOSE 8300

ENTRYPOINT ["/usr/local/bin/snork-server"]
CMD ["--host", "0.0.0.0:8300", "--latency", "150", "--config", "{\"Tree\":{}}"]
