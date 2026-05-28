# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# BUILD_TAGS is empty by default — that's the prod build (Railway, CI).
# docker-compose.yml passes BUILD_TAGS=dev for local dev which compiles
# internal/booking/dev_seed.go (the test harness) instead of the no-op
# stub. NEVER set this in any prod build pipeline. The triple gate on
# the dev endpoint defends against a leak; this is the first gate.
ARG BUILD_TAGS=""
RUN CGO_ENABLED=0 GOOS=linux go build -tags "${BUILD_TAGS}" -trimpath -ldflags="-s -w" -o /out/api ./cmd/api
RUN CGO_ENABLED=0 GOOS=linux go build -tags "${BUILD_TAGS}" -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate
RUN CGO_ENABLED=0 GOOS=linux go build -tags "${BUILD_TAGS}" -trimpath -ldflags="-s -w" -o /out/crm-api ./cmd/crm-api

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 app
WORKDIR /app
COPY --from=build /out/api /usr/local/bin/api
COPY --from=build /out/migrate /usr/local/bin/migrate
COPY --from=build /out/crm-api /usr/local/bin/crm-api
COPY schemas /app/schemas
COPY migrations /app/migrations
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
