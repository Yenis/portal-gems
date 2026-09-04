# Host build for wormhole-mini: development and tests on Linux.
# The Symbian build (phase S5) uses the same src/ and vendor/ files with
# port/symbian.cpp in place of port/posix.c.

CC ?= gcc
# -std=c89 for the old Symbian toolchain. Not -pedantic: TweetNaCl and our
# secretbox wrapper use `long long`, which C89 does not have but every
# compiler we care about does.
CFLAGS ?= -std=c89 -Wall -Wextra -O2
VENDOR_CFLAGS = -std=gnu89 -O2 -w

SRC = src/sha256.c src/kdf.c src/box.c src/spake2.c \
      src/sha1.c src/base64.c src/json.c src/ws.c src/mailbox.c
PORT = port/posix.c
# src/ed25519.c compiles vendor/tweetnacl/tweetnacl.c inside itself to reach
# its static ed25519 internals, so tweetnacl.c is never built separately -
# doing both would be a duplicate-symbol link error. Built with the relaxed
# vendor flags because it is mostly vendored code.
ED25519 = src/ed25519.c

BUILD = build

.PHONY: all test clean vectors cli

all: test

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/ed25519.o: $(ED25519) $(VENDOR) | $(BUILD)
	$(CC) $(VENDOR_CFLAGS) -c $(ED25519) -o $@

$(BUILD)/test_vectors: tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/ed25519.o

$(BUILD)/test_proto: tests/test_proto.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_proto.c $(SRC) $(PORT) $(BUILD)/ed25519.o

$(BUILD)/wh-mini: cli/wh-mini.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ cli/wh-mini.c $(SRC) $(PORT) $(BUILD)/ed25519.o

cli: $(BUILD)/wh-mini

test: $(BUILD)/test_vectors $(BUILD)/test_proto
	./$(BUILD)/test_vectors
	@echo
	./$(BUILD)/test_proto

# Regenerate the committed vectors from the engine's own crates.
vectors:
	cargo run --quiet --manifest-path tools/genvectors/Cargo.toml > tests/vectors/vectors.h

clean:
	rm -rf $(BUILD)
