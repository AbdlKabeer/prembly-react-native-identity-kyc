package com.prembly.device

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.util.concurrent.Executors

class PremblyDeviceModule(reactContext: ReactApplicationContext) :
  NativePremblyDeviceSpec(reactContext) {

  // The checks touch the file system and system services, so keep them off the JS thread.
  private val worker = Executors.newSingleThreadExecutor()

  private val collector by lazy { SignalCollector(reactApplicationContext) }

  override fun getAppInfo(promise: Promise) {
    promise.resolve(collector.appInfo().toString())
  }

  override fun getDeviceId(promise: Promise) {
    worker.execute {
      try {
        promise.resolve(DeviceIdStore.deviceId(reactApplicationContext))
      } catch (error: Throwable) {
        promise.reject("device_id_failed", error.message, error)
      }
    }
  }

  override fun collectSignals(includeLocation: Boolean, promise: Promise) {
    worker.execute {
      try {
        promise.resolve(collector.collect(includeLocation).toString())
      } catch (error: Throwable) {
        promise.reject("collect_failed", error.message, error)
      }
    }
  }

  override fun checkScreenCapture(promise: Promise) {
    worker.execute {
      try {
        promise.resolve(collector.screenCapture().toString())
      } catch (error: Throwable) {
        promise.reject("screen_capture_failed", error.message, error)
      }
    }
  }

  override fun invalidate() {
    worker.shutdown()
    super.invalidate()
  }

  companion object {
    const val NAME = NativePremblyDeviceSpec.NAME
  }
}
