#import "PremblyDevice.h"

#import "TMDeviceIdStore.h"
#import "TMSignalCollector.h"

static NSString *JSONString(id object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
}

@implementation PremblyDevice

- (void)getAppInfo:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve(JSONString([TMSignalCollector appInfo]));
}

- (void)getDeviceId:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    resolve([TMDeviceIdStore deviceId]);
  });
}

- (void)collectSignals:(BOOL)includeLocation
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  // Off the main thread: the checks touch the file system. The collector hops to the main
  // thread itself for the few UIKit and CoreLocation reads.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try {
      resolve(JSONString([TMSignalCollector collectIncludingLocation:includeLocation]));
    } @catch (NSException *exception) {
      reject(@"collect_failed", exception.reason, nil);
    }
  });
}

- (void)checkScreenCapture:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try {
      resolve(JSONString([TMSignalCollector screenCapture]));
    } @catch (NSException *exception) {
      reject(@"screen_capture_failed", exception.reason, nil);
    }
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativePremblyDeviceSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"PremblyDevice";
}

@end
