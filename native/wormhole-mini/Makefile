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
      src/sha1.c src/base64.c src/json.c src/ws.c src/mailbox.c \
      src/transit.c src/xfer.c \
      src/wordlist.c src/code.c src/crc32.c src/inflate.c src/zip.c
PORT = port/posix.c
# src/ed25519.c compiles vendor/tweetnacl/tweetnacl.c inside itself to reach
# its static ed25519 internals, so tweetnacl.c is never built separately -
# doing both would be a duplicate-symbol link error. Built with the relaxed
# vendor flags because it is mostly vendored code.
ED25519 = src/ed25519.c

BUILD = build

# 32-bit ARM cross build, standing in for the phone until the Symbian SDK is
# in place. arm-linux-gnueabi is ARMv5 soft-float with a 32-bit long, which
# is the data model Symbian uses on the E72's ARM11 - so this catches width
# and alignment mistakes that a 64-bit host build cannot. Static linking
# keeps qemu from needing an ARM sysroot at run time.
ARM_CC ?= arm-linux-gnueabi-gcc
QEMU ?= qemu-arm-static

.PHONY: all test test-arm clean vectors inflate-vectors zip-vectors wordlist cli cli-arm

all: test

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/ed25519.o: $(ED25519) $(VENDOR) | $(BUILD)
	$(CC) $(VENDOR_CFLAGS) -c $(ED25519) -o $@

$(BUILD)/test_vectors: tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/ed25519.o

$(BUILD)/test_inflate: tests/test_inflate.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_inflate.c $(SRC) $(PORT) $(BUILD)/ed25519.o

$(BUILD)/test_zip: tests/test_zip.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_zip.c $(SRC) $(PORT) $(BUILD)/ed25519.o

$(BUILD)/test_proto: tests/test_proto.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ tests/test_proto.c $(SRC) $(PORT) $(BUILD)/ed25519.o

$(BUILD)/wh-mini: cli/wh-mini.c $(SRC) $(PORT) $(BUILD)/ed25519.o | $(BUILD)
	$(CC) $(CFLAGS) -o $@ cli/wh-mini.c $(SRC) $(PORT) $(BUILD)/ed25519.o

cli: $(BUILD)/wh-mini

test: $(BUILD)/test_vectors $(BUILD)/test_proto $(BUILD)/test_inflate $(BUILD)/test_zip
	./$(BUILD)/test_vectors
	@echo
	./$(BUILD)/test_proto
	@echo
	./$(BUILD)/test_inflate
	@echo
	./$(BUILD)/test_zip

$(BUILD)/arm:
	mkdir -p $(BUILD)/arm

$(BUILD)/arm/ed25519.o: $(ED25519) $(VENDOR) | $(BUILD)/arm
	$(ARM_CC) $(VENDOR_CFLAGS) -c $(ED25519) -o $@

$(BUILD)/arm/test_vectors: tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o | $(BUILD)/arm
	$(ARM_CC) $(CFLAGS) -static -o $@ tests/test_vectors.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o

$(BUILD)/arm/test_inflate: tests/test_inflate.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o | $(BUILD)/arm
	$(ARM_CC) $(CFLAGS) -static -o $@ tests/test_inflate.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o

$(BUILD)/arm/test_zip: tests/test_zip.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o | $(BUILD)/arm
	$(ARM_CC) $(CFLAGS) -static -o $@ tests/test_zip.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o

$(BUILD)/arm/test_proto: tests/test_proto.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o | $(BUILD)/arm
	$(ARM_CC) $(CFLAGS) -static -o $@ tests/test_proto.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o

$(BUILD)/arm/wh-mini: cli/wh-mini.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o | $(BUILD)/arm
	$(ARM_CC) $(CFLAGS) -static -o $@ cli/wh-mini.c $(SRC) $(PORT) $(BUILD)/arm/ed25519.o

cli-arm: $(BUILD)/arm/wh-mini

test-arm: $(BUILD)/arm/test_vectors $(BUILD)/arm/test_proto $(BUILD)/arm/test_inflate $(BUILD)/arm/test_zip
	$(QEMU) ./$(BUILD)/arm/test_vectors
	@echo
	$(QEMU) ./$(BUILD)/arm/test_proto
	@echo
	$(QEMU) ./$(BUILD)/arm/test_inflate
	@echo
	$(QEMU) ./$(BUILD)/arm/test_zip

# Regenerate the committed PGP wordlist from the engine's own JSON.
wordlist:
	python3 tools/genwordlist.py > src/wordlist.c

# Regenerate the committed vectors from the engine's own crates.
# Regenerate the deflate vectors from zlib.
inflate-vectors:
	python3 tools/geninflate.py > tests/vectors/inflate_vectors.h

# Regenerate the zip vectors from Python's zipfile.
zip-vectors:
	python3 tools/genzip.py > tests/vectors/zip_vectors.h

vectors:
	cargo run --quiet --manifest-path tools/genvectors/Cargo.toml > tests/vectors/vectors.h

clean:
	rm -rf $(BUILD)
