#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Reads signals from the device. It uses no React Native types, so the same file can be reused by
/// a Flutter plugin. It never asks for a permission: location is read only when the app already
/// holds it.
@interface TMSignalCollector : NSObject

/// `{ device, integrity, network, scam_signals }`, plus `location` when asked for and available.
+ (NSDictionary<NSString *, id> *)collectIncludingLocation:(BOOL)includeLocation;

/// `{ is_screen_shared_or_recorded }` only: cheap enough to read every couple of seconds while a
/// verification is open.
+ (NSDictionary<NSString *, id> *)screenCapture;

/// `{ appId, appVersion, appBuild }`.
+ (NSDictionary<NSString *, NSString *> *)appInfo;

@end

NS_ASSUME_NONNULL_END
