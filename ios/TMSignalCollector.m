#import "TMSignalCollector.h"

#import <CFNetwork/CFNetwork.h>
#import <CoreLocation/CoreLocation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <TargetConditionals.h>
#import <UIKit/UIKit.h>
#import <mach-o/dyld.h>
#import <netinet/in.h>
#import <sys/sysctl.h>
#import <unistd.h>

@implementation TMSignalCollector

#pragma mark - Public

+ (NSDictionary<NSString *, id> *)collectIncludingLocation:(BOOL)includeLocation {
  NSMutableDictionary *signals = [NSMutableDictionary dictionary];
  signals[@"device"] = [self deviceSection];
  signals[@"integrity"] = [self integritySection];
  signals[@"network"] = [self networkSection];
  signals[@"scam_signals"] = [self scamSection];

  if (includeLocation) {
    NSDictionary *location = [self locationSection];
    if (location) {
      signals[@"location"] = location;
    }
  }
  return signals;
}

+ (NSDictionary<NSString *, NSString *> *)appInfo {
  NSBundle *bundle = [NSBundle mainBundle];
  return @{
    @"appId" : bundle.bundleIdentifier ?: @"",
    @"appVersion" : [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
    @"appBuild" : [bundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"",
  };
}

#pragma mark - Device

+ (NSString *)sysctlString:(const char *)name {
  size_t size = 0;
  if (sysctlbyname(name, NULL, &size, NULL, 0) != 0 || size == 0) {
    return @"";
  }
  char *buffer = malloc(size);
  NSString *value = @"";
  if (sysctlbyname(name, buffer, &size, NULL, 0) == 0) {
    value = [NSString stringWithUTF8String:buffer] ?: @"";
  }
  free(buffer);
  return value;
}

+ (NSDictionary *)deviceSection {
  NSBundle *bundle = [NSBundle mainBundle];
  UIDevice *device = [UIDevice currentDevice];
  NSString *model = [self sysctlString:"hw.machine"];
#if TARGET_OS_SIMULATOR
  // On the simulator hw.machine is the Mac's architecture; the simulated model is in the environment.
  NSString *simulated = NSProcessInfo.processInfo.environment[@"SIMULATOR_MODEL_IDENTIFIER"];
  if (simulated.length > 0) {
    model = simulated;
  }
#endif
  NSMutableDictionary *section = [@{
    @"type" : device.userInterfaceIdiom == UIUserInterfaceIdiomPad ? @"tablet" : @"phone",
    @"model" : model,
    @"manufacturer" : @"Apple",
    @"os_name" : @"ios",
    @"os_version" : device.systemVersion ?: @"",
    @"app_version" : [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
    @"app_build" : [bundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"",
    @"locale" : [self languageTag],
    @"timezone" : [NSTimeZone localTimeZone].name ?: @"",
    // The ID iOS keeps for this app's vendor on this phone. It is the same for every app from the
    // vendor and only changes once all of them are deleted.
    @"platform_device_id" : device.identifierForVendor.UUIDString ?: @"",
    @"total_memory_mb" : @(NSProcessInfo.processInfo.physicalMemory / (1024 * 1024)),
    @"cpu_cores" : @(NSProcessInfo.processInfo.activeProcessorCount),
  } mutableCopy];
  [section addEntriesFromDictionary:[self screenMetrics]];
  return section;
}

/// UIKit must be read on the main thread.
+ (NSDictionary *)screenMetrics {
  __block NSDictionary *metrics = nil;
  void (^read)(void) = ^{
    UIScreen *screen = UIScreen.mainScreen;
    metrics = @{
      @"screen_width" : @(screen.nativeBounds.size.width),
      @"screen_height" : @(screen.nativeBounds.size.height),
      @"screen_density" : @(screen.nativeScale),
    };
  };
  if ([NSThread isMainThread]) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read);
  }
  return metrics ?: @{};
}

/// The user's preferred language as a BCP 47 tag, for example "en-US". The locale identifier is
/// avoided because it can carry region overrides such as "en-US@rg=ngzzzz".
+ (NSString *)languageTag {
  NSString *preferred = [NSLocale preferredLanguages].firstObject;
  if (preferred.length > 0) {
    return preferred;
  }
  return [[NSLocale currentLocale].localeIdentifier stringByReplacingOccurrencesOfString:@"_"
                                                                              withString:@"-"];
}

#pragma mark - Integrity

+ (BOOL)isSimulator {
#if TARGET_OS_SIMULATOR
  return YES;
#else
  return NO;
#endif
}

+ (BOOL)isDebuggerAttached {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  struct kinfo_proc info;
  size_t size = sizeof(info);
  memset(&info, 0, sizeof(info));
  if (sysctl(mib, 4, &info, &size, NULL, 0) != 0) {
    return NO;
  }
  return (info.kp_proc.p_flag & P_TRACED) != 0;
}

/// Best effort: a determined attacker can hide a jailbreak. Never run on the simulator, where the
/// host Mac's files would make every check pass.
+ (BOOL)isJailbroken {
  if ([self isSimulator]) {
    return NO;
  }

  NSFileManager *files = [NSFileManager defaultManager];
  NSArray<NSString *> *paths = @[
    @"/Applications/Cydia.app", @"/Applications/Sileo.app", @"/Applications/Zebra.app",
    @"/Library/MobileSubstrate/MobileSubstrate.dylib", @"/bin/bash", @"/usr/sbin/sshd",
    @"/etc/apt", @"/private/var/lib/apt/", @"/usr/bin/ssh", @"/var/jb",
  ];
  for (NSString *path in paths) {
    if ([files fileExistsAtPath:path]) {
      return YES;
    }
  }

  // A sandboxed app cannot write outside its container.
  NSString *probe = @"/private/tmp_tm_probe";
  NSError *error = nil;
  if ([@"x" writeToFile:probe atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    [files removeItemAtPath:probe error:nil];
    return YES;
  }

  // Hooking and injection libraries loaded into this process.
  NSArray<NSString *> *markers = @[ @"MobileSubstrate", @"Substrate", @"FridaGadget", @"cynject",
                                    @"libcycript", @"SSLKillSwitch" ];
  uint32_t count = _dyld_image_count();
  for (uint32_t i = 0; i < count; i++) {
    const char *name = _dyld_get_image_name(i);
    if (name == NULL) {
      continue;
    }
    NSString *image = [NSString stringWithUTF8String:name];
    for (NSString *marker in markers) {
      if ([image rangeOfString:marker options:NSCaseInsensitiveSearch].location != NSNotFound) {
        return YES;
      }
    }
  }
  return NO;
}

+ (BOOL)hasDeviceLock {
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error];
}

+ (NSDictionary *)integritySection {
  return @{
    @"is_rooted" : @([self isJailbroken]),
    @"is_emulator" : @([self isSimulator]),
    @"is_debugger_attached" : @([self isDebuggerAttached]),
    @"is_device_secure" : @([self hasDeviceLock]),
  };
}

#pragma mark - Network

+ (NSString *)networkType {
  struct sockaddr_in zero;
  memset(&zero, 0, sizeof(zero));
  zero.sin_len = sizeof(zero);
  zero.sin_family = AF_INET;
  SCNetworkReachabilityRef reachability =
      SCNetworkReachabilityCreateWithAddress(NULL, (const struct sockaddr *)&zero);
  if (reachability == NULL) {
    return @"none";
  }
  SCNetworkReachabilityFlags flags = 0;
  BOOL known = SCNetworkReachabilityGetFlags(reachability, &flags);
  CFRelease(reachability);
  if (!known || !(flags & kSCNetworkReachabilityFlagsReachable)) {
    return @"none";
  }
  if (flags & kSCNetworkReachabilityFlagsIsWWAN) {
    return @"cellular";
  }
  return @"wifi";
}

+ (NSDictionary *)networkSection {
  BOOL vpn = NO;
  BOOL proxy = NO;

  CFDictionaryRef settingsRef = CFNetworkCopySystemProxySettings();
  if (settingsRef != NULL) {
    NSDictionary *settings = (__bridge_transfer NSDictionary *)settingsRef;

    // The scoped section lists the interfaces traffic is routed through. A VPN shows up as a
    // tunnel interface there (the always-present system utun interfaces do not).
    NSDictionary *scoped = settings[@"__SCOPED__"];
    for (NSString *interface in scoped) {
      for (NSString *marker in @[ @"tap", @"tun", @"ppp", @"ipsec" ]) {
        if ([interface rangeOfString:marker options:NSCaseInsensitiveSearch].location !=
            NSNotFound) {
          vpn = YES;
        }
      }
    }

    proxy = [settings[@"HTTPEnable"] boolValue] || [settings[@"HTTPSEnable"] boolValue];
  }

  return @{
    @"type" : [self networkType],
    @"is_vpn_active" : @(vpn),
    @"is_proxy_configured" : @(proxy),
  };
}

#pragma mark - Scam signals

/// UIKit must be read on the main thread.
+ (BOOL)isScreenCaptured {
  __block BOOL captured = NO;
  void (^read)(void) = ^{
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if ([scene isKindOfClass:[UIWindowScene class]] &&
          ((UIWindowScene *)scene).screen.isCaptured) {
        captured = YES;
      }
    }
  };
  if ([NSThread isMainThread]) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read);
  }
  return captured;
}

+ (NSDictionary<NSString *, id> *)screenCapture {
  return @{
    @"is_screen_shared_or_recorded" : @([self isScreenCaptured]),
  };
}

+ (NSDictionary *)scamSection {
  return @{
    @"is_screen_shared_or_recorded" : @([self isScreenCaptured]),
    // iOS does not let an app see which other apps are running.
    @"remote_access_app_running" : @NO,
  };
}

#pragma mark - Location

/// The last known location, only when the app already holds the permission. This never prompts.
+ (nullable NSDictionary *)locationSection {
  __block NSDictionary *result = nil;
  void (^read)(void) = ^{
    CLLocationManager *manager = [[CLLocationManager alloc] init];
    CLAuthorizationStatus status = manager.authorizationStatus;
    if (status != kCLAuthorizationStatusAuthorizedWhenInUse &&
        status != kCLAuthorizationStatusAuthorizedAlways) {
      return;
    }
    CLLocation *location = manager.location;
    if (location == nil) {
      return;
    }
    BOOL mock = NO;
    if (@available(iOS 15.0, *)) {
      mock = location.sourceInformation.isSimulatedBySoftware;
    }
    result = @{
      @"lat" : @(location.coordinate.latitude),
      @"lng" : @(location.coordinate.longitude),
      @"accuracy_m" : @(location.horizontalAccuracy),
      @"is_mock" : @(mock),
    };
  };
  if ([NSThread isMainThread]) {
    read();
  } else {
    dispatch_sync(dispatch_get_main_queue(), read);
  }
  return result;
}

@end
