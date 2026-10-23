#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The app-scoped device ID. Created on first use and kept in the Keychain, marked "this device
/// only", so it survives an app reinstall but is not copied to another device by a backup.
@interface TMDeviceIdStore : NSObject

+ (NSString *)deviceId;

@end

NS_ASSUME_NONNULL_END
