#import "TMDeviceIdStore.h"
#import <Security/Security.h>

static NSString *const kService = @"com.prembly.tmsdk.device";
static NSString *const kAccount = @"device_id";

@implementation TMDeviceIdStore

+ (NSDictionary *)baseQuery {
  return @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kService,
    (__bridge id)kSecAttrAccount : kAccount,
  };
}

+ (nullable NSString *)readStoredId {
  NSMutableDictionary *query = [[self baseQuery] mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;

  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status != errSecSuccess || result == NULL) {
    return nil;
  }
  NSData *data = (__bridge_transfer NSData *)result;
  NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return value.length > 0 ? value : nil;
}

+ (NSString *)deviceId {
  @synchronized(self) {
    NSString *existing = [self readStoredId];
    if (existing) {
      return existing;
    }

    NSString *fresh = [[NSUUID UUID] UUIDString].lowercaseString;
    NSMutableDictionary *attributes = [[self baseQuery] mutableCopy];
    attributes[(__bridge id)kSecValueData] = [fresh dataUsingEncoding:NSUTF8StringEncoding];
    attributes[(__bridge id)kSecAttrAccessible] =
        (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
    // If the Keychain is unavailable the ID is simply not kept: the next call makes a new one.
    SecItemAdd((__bridge CFDictionaryRef)attributes, NULL);
    return fresh;
  }
}

@end
