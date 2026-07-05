#include "WormholeRnImpl.h"

#include "wormhole-rn.h"

namespace facebook::react {

WormholeRnImpl::WormholeRnImpl(
  std::shared_ptr<CallInvoker> jsInvoker
)
  : NativeWormholeRnCxxSpec(std::move(jsInvoker)) {}

bool WormholeRnImpl::installRustCrate(jsi::Runtime& rt) {
  return wormholern::installRustCrate(rt, jsInvoker_) != 0;
}

bool WormholeRnImpl::cleanupRustCrate(jsi::Runtime& rt) {
  return wormholern::cleanupRustCrate(rt) != 0;
}

}
