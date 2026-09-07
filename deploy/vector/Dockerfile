# Keep the verified engine while refreshing OS security fixes and omitting the web UI.
FROM qdrant/qdrant:v1.14.1@sha256:419d72603f5346ee22ffc4606bdb7beb52fcb63077766fab678e6622ba247366 AS engine
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libunwind8 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /qdrant
COPY --from=engine /qdrant/qdrant /qdrant/qdrant
COPY --from=engine /qdrant/config /qdrant/config
RUN mkdir -p /qdrant/storage /qdrant/snapshots \
    && chown -R 1000:1000 /qdrant
USER 1000:1000
EXPOSE 6333 6334 6335
CMD ["/qdrant/qdrant"]
