#import "TMExtendedSignals.h"

#import <CallKit/CallKit.h>
#import <CoreLocation/CoreLocation.h>
#import <CoreTelephony/CTCarrier.h>
#import <CoreTelephony/CTTelephonyNetworkInfo.h>
#import <Security/Security.h>
#import <SystemConfiguration/CaptiveNetwork.h>
#import <TargetConditionals.h>
#import <UIKit/UIKit.h>

@implementation TMExtendedSignals

+ (NSDictionary<NSString *, id> *)deviceContext {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  [self put:out key:@"install_source" value:[self installSource]];
#if defined(__arm64__)
  out[@"cpu_architecture"] = @"arm64";
#elif defined(__x86_64__)
  out[@"cpu_architecture"] = @"x86_64";
#endif
  [self put:out key:@"storage_free_percent" value:[self storageFreePercent]];
  [self put:out key:@"battery_level" value:[self batteryLevel]];
  [out addEntriesFromDictionary:[self carrier]];
  [out addEntriesFromDictionary:[self wifi]];
  [self put:out key:@"apple_team_id" value:[self teamId]];
  return out;
}

+ (void)put:(NSMutableDictionary *)out key:(NSString *)key value:(nullable id)value {
  if (value != nil) {
    out[key] = value;
  }
}

/// Where the app came from: "app_store", "testflight", "development" (a provisioning profile is
/// embedded: development, ad hoc or enterprise) or "simulator".
+ (nullable NSString *)installSource {
#if TARGET_OS_SIMULATOR
  return @"simulator";
#else
  NSBundle *bundle = NSBundle.mainBundle;
  if ([bundle.appStoreReceiptURL.lastPathComponent isEqualToString:@"sandboxReceipt"]) {
    return @"testflight";
  }
  if ([bundle pathForResource:@"embedded" ofType:@"mobileprovision"] != nil) {
    return @"development";
  }
  return @"app_store";
#endif
}

+ (nullable NSNumber *)storageFreePercent {
  NSURL *home = [NSURL fileURLWithPath:NSHomeDirectory()];
  NSDictionary *values = [home resourceValuesForKeys:@[
    NSURLVolumeTotalCapacityKey, NSURLVolumeAvailableCapacityKey
  ] error:nil];
  double total = [values[NSURLVolumeTotalCapacityKey] doubleValue];
  double free = [values[NSURLVolumeAvailableCapacityKey] doubleValue];
  if (total <= 0) {
    return nil;
  }
  return @(MIN(100.0, MAX(0.0, round(free / total * 1000.0) / 10.0)));
}

/// UIKit's battery reading must happen on the main thread. -1 means iOS cannot tell (simulator).
+ (nullable NSNumber *)batteryLevel {
  __block NSNumber *level = nil;
  void (^read)(void) = ^{
    UIDevice *device = UIDevice.currentDevice;
    BOOL was = device.batteryMonitoringEnabled;
    device.batteryMonitoringEnabled = YES;
    float value = device.batteryLevel;
    device.batteryMonitoringEnabled = was;
    if (value >= 0) {
      level = @((int)round(value * 100));
    }
  };
  if ([NSThread isMainThread]) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read);
  }
  return level;
}

/// iOS 16 and later no longer reveal the carrier and return placeholder values; those are dropped.
+ (NSDictionary<NSString *, id> *)carrier {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CTTelephonyNetworkInfo *info = [[CTTelephonyNetworkInfo alloc] init];
  CTCarrier *carrier = nil;
  if (@available(iOS 12.0, *)) {
    carrier = info.serviceSubscriberCellularProviders.allValues.firstObject;
  }
  if (carrier == nil) {
    carrier = info.subscriberCellularProvider;
  }
  NSString *mcc = carrier.mobileCountryCode;
  NSString *mnc = carrier.mobileNetworkCode;
  NSString *name = carrier.carrierName;
  NSString *country = carrier.isoCountryCode;
#pragma clang diagnostic pop
  if (mcc.length > 0 && mnc.length > 0 && ![mcc isEqualToString:@"65535"]) {
    out[@"carrier_mcc"] = mcc;
    out[@"carrier_mnc"] = mnc;
    if (name.length > 0 && ![name isEqualToString:@"--"]) {
      out[@"carrier_name"] = name;
    }
    if (country.length > 0) {
      out[@"carrier_country"] = country.uppercaseString;
    }
  }
  return out;
}

/// The wifi name and access point. iOS only gives them to an app with the "Access WiFi Information"
/// entitlement and location permission, so without both nothing is sent.
+ (NSDictionary<NSString *, id> *)wifi {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  CLAuthorizationStatus status = kCLAuthorizationStatusNotDetermined;
  if (@available(iOS 14.0, *)) {
    status = [[CLLocationManager alloc] init].authorizationStatus;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    status = [CLLocationManager authorizationStatus];
#pragma clang diagnostic pop
  }
  if (status != kCLAuthorizationStatusAuthorizedWhenInUse &&
      status != kCLAuthorizationStatusAuthorizedAlways) {
    return out;
  }
#if !TARGET_OS_SIMULATOR
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CFArrayRef interfaces = CNCopySupportedInterfaces();
  if (interfaces != NULL) {
    for (NSString *name in (__bridge NSArray *)interfaces) {
      NSDictionary *network =
          (__bridge_transfer NSDictionary *)CNCopyCurrentNetworkInfo((__bridge CFStringRef)name);
      NSString *ssid = network[(__bridge NSString *)kCNNetworkInfoKeySSID];
      NSString *bssid = network[(__bridge NSString *)kCNNetworkInfoKeyBSSID];
      if (ssid.length > 0) {
        out[@"wifi_ssid"] = ssid;
      }
      NSString *padded = [self paddedBssid:bssid];
      if (padded != nil) {
        out[@"wifi_bssid"] = padded;
      }
      if (out.count > 0) {
        break;
      }
    }
    CFRelease(interfaces);
  }
#pragma clang diagnostic pop
#endif
  return out;
}

/// iOS drops leading zeros ("0:1a:2b:..."); the server expects six two-digit pairs.
+ (nullable NSString *)paddedBssid:(nullable NSString *)raw {
  NSArray<NSString *> *parts = [raw componentsSeparatedByString:@":"];
  if (parts.count != 6) {
    return nil;
  }
  NSMutableArray *padded = [NSMutableArray array];
  for (NSString *part in parts) {
    if (part.length == 0 || part.length > 2) {
      return nil;
    }
    [padded addObject:part.length == 1 ? [@"0" stringByAppendingString:part] : part];
  }
  return [padded componentsJoinedByString:@":"];
}

/// The Apple team that signed this install. iOS has no call for it, but a keychain item an app
/// creates is stamped with an access group that starts with the team ID, so we read it from there.
+ (nullable NSString *)teamId {
  NSDictionary *query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrAccount : @"prembly.team-id-probe",
    (__bridge id)kSecAttrService : @"prembly.team-id-probe",
    (__bridge id)kSecReturnAttributes : @YES,
  };
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) {
    NSMutableDictionary *add = [query mutableCopy];
    [add removeObjectForKey:(__bridge id)kSecReturnAttributes];
    add[(__bridge id)kSecReturnAttributes] = @YES;
    add[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlock;
    status = SecItemAdd((__bridge CFDictionaryRef)add, &result);
  }
  if (status != errSecSuccess || result == NULL) {
    return nil;
  }
  NSDictionary *attributes = (__bridge_transfer NSDictionary *)result;
  NSString *group = attributes[(__bridge id)kSecAttrAccessGroup];
  NSRange dot = [group rangeOfString:@"."];
  if (dot.location == NSNotFound || dot.location == 0 || dot.location > 10) {
    return nil;
  }
  return [group substringToIndex:dot.location];
}

+ (nullable NSNumber *)onPhoneCall {
  CXCallObserver *observer = [[CXCallObserver alloc] init];
  for (CXCall *call in observer.calls) {
    if (!call.hasEnded) {
      return @YES;
    }
  }
  return @NO;
}

@end
