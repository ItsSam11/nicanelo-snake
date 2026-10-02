FROM maven:3.9-eclipse-temurin-21 AS build

ARG NESSEGREV_COMMIT=ebd1981b66256ff8a8477ed2a2ca0f655df60849

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init \
  && git remote add origin https://github.com/nettogrof/nessegrev-java-dev.git \
  && git fetch --depth 1 origin "${NESSEGREV_COMMIT}" \
  && git checkout --detach FETCH_HEAD \
  && mvn --batch-mode --no-transfer-progress \
    -DskipTests -Dmaven.javadoc.skip=true package

FROM eclipse-temurin:21-jre-jammy

WORKDIR /app
COPY --from=build /src/target/snake-java.jar /app/snake.jar
COPY --from=build /src/Expert.properties /app/Expert.properties
COPY --from=build /src/evaluation.properties /app/evaluation.properties
COPY --from=build /src/logging.properties /app/logging.properties

RUN sed -i 's/^port=8084$/port=8400/' /app/Expert.properties \
  && sed -i 's/^\.level= INFO$/.level= WARNING/' /app/logging.properties \
  && sed -i 's/^java.util.logging.ConsoleHandler.level = INFO$/java.util.logging.ConsoleHandler.level = WARNING/' /app/logging.properties

EXPOSE 8400
ENTRYPOINT ["java", "-Djava.util.logging.config.file=/app/logging.properties", "-Xms512m", "-Xmx1024m", "-jar", "/app/snake.jar", "Expert"]
