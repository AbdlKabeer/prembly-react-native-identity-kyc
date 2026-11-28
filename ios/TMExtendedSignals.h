#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Extra context about the phone. Every value is best effort: one that iOS will not give is left
/// out, never guessed. Nothing here asks for a permission.
@interface TMExtendedSignals : NSObject

/// Fields to merge into the `device` section: install source, CPU architecture, free storage,
/// battery, carrier (where iOS still reports it), wifi name and access point (only when the app has
/// the wifi entitlement and location permission) and the Apple team ID the app is signed by.
+ (NSDictionary<NSString *, id> *)deviceContext;

/// Whether a phone call is in progress. nil when it cannot be told.
+ (nullable NSNumber *)onPhoneCall;

@end

NS_ASSUME_NONNULL_END
