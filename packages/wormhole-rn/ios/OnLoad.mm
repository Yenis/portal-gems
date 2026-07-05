#import <Foundation/Foundation.h>
#import "WormholeRnImpl.h"
#import <ReactCommon/CxxTurboModuleUtils.h>

@interface WormholeRnOnLoad : NSObject
@end

@implementation WormholeRnOnLoad

using namespace facebook::react;

+ (void)load
{
  registerCxxModuleToGlobalModuleMap(
    std::string(WormholeRnImpl::kModuleName),
    [](std::shared_ptr<CallInvoker> jsInvoker) {
      return std::make_shared<WormholeRnImpl>(jsInvoker);
    }
  );
}

@end
