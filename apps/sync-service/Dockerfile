FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go vet ./... && go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sync-service ./cmd/server

FROM alpine:3.21
RUN adduser -D -u 10001 app
COPY --from=build /out/sync-service /usr/local/bin/sync-service
USER app
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8081/sync/health || exit 1
ENTRYPOINT ["sync-service"]
