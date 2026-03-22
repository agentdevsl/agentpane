.PHONY: build test fmt vet clean

VERSION ?= $(shell cat version/version.go | grep 'Version =' | sed 's/.*"\(.*\)"/\1/')
BINARY := agentpane
LDFLAGS := -ldflags "-s -w -X 'github.com/agentdevsl/agentpane/cli/version.Version=$(VERSION)'"

build:
	go build $(LDFLAGS) -o $(BINARY) .

test:
	go test -v -timeout 5m ./...

fmt:
	gofmt -s -w .

vet:
	go vet ./...

clean:
	rm -f $(BINARY)

lint: fmt vet

all: lint test build
