#pragma once

#include <WormholeRnSpecJSI.h>

#include <memory>

namespace facebook::react {

// Pure C++ turbo-module (RN >= 0.77 CRNL template): bridges the codegen'd
// spec to the uniffi-bindgen-react-native rust-crate installer.
class WormholeRnImpl
  : public NativeWormholeRnCxxSpec<WormholeRnImpl> {
public:
  WormholeRnImpl(std::shared_ptr<CallInvoker> jsInvoker);

  bool installRustCrate(jsi::Runtime& rt);
  bool cleanupRustCrate(jsi::Runtime& rt);
};

}
