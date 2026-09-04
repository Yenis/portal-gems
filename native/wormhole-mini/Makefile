# Host build for wormhole-mini: development and tests on Linux.
# The Symbian build (phase S5) uses the same src/ and vendor/ files with
# port/symbian.cpp in place of port/posix.c.

CC ?= gcc
# -std=c89 for the old Symbian toolchain. Not -pedantic: TweetNaCl and our
# secretbox wrapper use `long long`, which C89 does not have but every
# compiler we care about does.
CFLAGS ?= -std=c89 -Wall -Wextra -O2
VENDOR_CFLAGS = -std=gnu89 -O2 -w

SRC = src/sha256.c src/kdf.c src/box.c
PORT = port/posix.c
VENDOR = vendor/tweetnacl/tweetnacl.c

BUILD = build

.PHONY: all test clean vectors

all: test

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/tweetnacl.o: $(VENDOR) | $(BUILD)
	$(CC) $(VENDOR_CFLAGS) -c $< -o $@

$(BUILD)/test_vectors: tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/tweetnacl.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/tweetnacl.o

test: $(BUILD)/test_vectors
	./$(BUILD)/test_vectors

# Regenerate the committed vectors from the engine's own crates.
vectors:
	cargo run --quiet --manifest-path tools/genvectors/Cargo.toml > tests/vectors/vectors.h

clean:
	rm -rf $(BUILD)
