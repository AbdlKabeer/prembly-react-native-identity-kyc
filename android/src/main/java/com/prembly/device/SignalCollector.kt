package com.prembly.device

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.ActivityManager
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.location.Location
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Debug
import android.provider.Settings
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import java.io.File
import java.util.Locale
import java.util.TimeZone
import java.util.function.Consumer
import org.json.JSONObject

/**
 * Reads signals from the device. It uses no React Native types, so the same file can be reused by
 * a Flutter plugin. It never asks for a permission: location is read only when the app already
 * holds it.
 */
internal class SignalCollector(private val context: Context) {

  fun appInfo(): JSONObject {
    val info = packageInfo()
    return JSONObject()
      .put("appId", context.packageName)
      .put("appVersion", info?.versionName ?: "")
      .put("appBuild", info?.let { buildNumber(it) } ?: "")
  }

  fun collect(includeLocation: Boolean): JSONObject {
    val signals =
      JSONObject()
        .put("device", deviceSection())
        .put("integrity", integritySection())
        .put("network", networkSection())
        .put("scam_signals", scamSection())

    if (includeLocation) {
      locationSection()?.let { signals.put("location", it) }
    }
    return signals
  }

  // ---- Device ---------------------------------------------------------------------------

  private fun deviceSection(): JSONObject {
    val info = packageInfo()
    val tablet = context.resources.configuration.smallestScreenWidthDp >= 600
    val metrics = context.resources.displayMetrics
    return JSONObject()
      .put("type", if (tablet) "tablet" else "phone")
      .put("model", Build.MODEL ?: "")
      .put("manufacturer", Build.MANUFACTURER ?: "")
      .put("os_name", "android")
      .put("os_version", Build.VERSION.RELEASE ?: "")
      .put("app_version", info?.versionName ?: "")
      .put("app_build", info?.let { buildNumber(it) } ?: "")
      .put("locale", Locale.getDefault().toLanguageTag())
      .put("timezone", TimeZone.getDefault().id)
      // The ID Android keeps for this app's signing key on this phone. It survives a reinstall and
      // only changes on a factory reset, which our own random ID (lost on uninstall) cannot do.
      .put("platform_device_id", androidId())
      .put("brand", Build.BRAND ?: "")
      .put("sdk_int", Build.VERSION.SDK_INT)
      .put("security_patch", Build.VERSION.SECURITY_PATCH ?: "")
      .put("total_memory_mb", totalMemoryMb())
      .put("cpu_cores", Runtime.getRuntime().availableProcessors())
      .put("screen_width", metrics.widthPixels)
      .put("screen_height", metrics.heightPixels)
      .put("screen_density", metrics.density.toDouble())
  }

  private fun androidId(): String =
    runCatching { Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) }
      .getOrNull() ?: ""

  private fun totalMemoryMb(): Long =
    runCatching {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        info.totalMem / (1024 * 1024)
      }
      .getOrDefault(0L)

  private fun packageInfo() =
    runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()

  @Suppress("DEPRECATION")
  private fun buildNumber(info: android.content.pm.PackageInfo): String =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode.toString()
    else info.versionCode.toString()

  // ---- Integrity ------------------------------------------------------------------------

  private fun integritySection(): JSONObject {
    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    return JSONObject()
      .put("is_rooted", isRooted())
      .put("is_emulator", isEmulator())
      .put("is_debugger_attached", Debug.isDebuggerConnected() || Debug.waitingForDebugger())
      .put("developer_options_enabled", globalSetting(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED))
      .put("usb_debugging_enabled", globalSetting(Settings.Global.ADB_ENABLED))
      .put("is_device_secure", keyguard?.isDeviceSecure ?: true)
  }

  private fun globalSetting(name: String): Boolean =
    runCatching { Settings.Global.getInt(context.contentResolver, name, 0) == 1 }
      .getOrDefault(false)

  /** Best effort: a determined attacker can hide root. */
  private fun isRooted(): Boolean {
    if (Build.TAGS?.contains("test-keys") == true) return true

    val suPaths =
      listOf(
        "/system/app/Superuser.apk",
        "/sbin/su",
        "/system/bin/su",
        "/system/xbin/su",
        "/data/local/xbin/su",
        "/data/local/bin/su",
        "/system/sd/xbin/su",
        "/system/bin/failsafe/su",
        "/data/local/su",
        "/su/bin/su",
        "/system/bin/.ext/.su",
      )
    if (suPaths.any { File(it).exists() }) return true

    val onPath =
      (System.getenv("PATH") ?: "").split(":").filter { it.isNotEmpty() }.any {
        File(it, "su").exists()
      }
    if (onPath) return true

    return RemoteAccessApps.ROOT_MANAGER_PACKAGES.any { isInstalled(it) }
  }

  private fun isEmulator(): Boolean {
    val fingerprint = Build.FINGERPRINT ?: ""
    val model = Build.MODEL ?: ""
    val hardware = Build.HARDWARE ?: ""
    val product = Build.PRODUCT ?: ""
    return fingerprint.startsWith("generic") ||
      fingerprint.contains("emulator", ignoreCase = true) ||
      fingerprint.contains("sdk_gphone", ignoreCase = true) ||
      model.contains("Emulator", ignoreCase = true) ||
      model.contains("Android SDK built for", ignoreCase = true) ||
      model.contains("sdk_gphone", ignoreCase = true) ||
      (Build.MANUFACTURER ?: "").contains("Genymotion", ignoreCase = true) ||
      hardware.contains("goldfish", ignoreCase = true) ||
      hardware.contains("ranchu", ignoreCase = true) ||
      product.contains("sdk", ignoreCase = true) ||
      product.contains("emulator", ignoreCase = true) ||
      product.contains("vbox", ignoreCase = true) ||
      ((Build.BRAND ?: "").startsWith("generic") && (Build.DEVICE ?: "").startsWith("generic"))
  }

  // ---- Network --------------------------------------------------------------------------

  private fun networkSection(): JSONObject {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    val capabilities =
      runCatching { manager?.getNetworkCapabilities(manager.activeNetwork) }.getOrNull()

    val type =
      when {
        capabilities == null -> "none"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
        else -> "other"
      }
    val vpn = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    val proxy =
      runCatching { manager?.defaultProxy != null }.getOrDefault(false) ||
        !System.getProperty("http.proxyHost").isNullOrBlank()

    return JSONObject().put("type", type).put("is_vpn_active", vpn).put("is_proxy_configured", proxy)
  }

  // ---- Scam signals ---------------------------------------------------------------------

  private fun scamSection(): JSONObject {
    val serviceInRemoteAccessApp = enabledAccessibilityPackages().any {
      it in RemoteAccessApps.PACKAGES
    }
    return JSONObject()
      .put("is_screen_shared_or_recorded", isScreenCaptured())
      // Android does not let an app see which other apps are running. A remote-control app has to
      // turn on its accessibility service to control the screen, so an enabled service from one of
      // the known packages is the closest reliable sign that it is active now.
      .put("remote_access_app_running", serviceInRemoteAccessApp)
      .put("remote_access_app_installed", RemoteAccessApps.PACKAGES.any { isInstalled(it) })
  }

  /**
   * Just the screen-capture flag, cheap enough to read every couple of seconds while a verification
   * is open. A recording that starts after the first snapshot would otherwise go unseen.
   */
  fun screenCapture(): JSONObject = JSONObject().put("is_screen_shared_or_recorded", isScreenCaptured())

  /** Whether the screen is being recorded, cast or mirrored right now. */
  private fun isScreenCaptured(): Boolean = isScreenRecorded() || isScreenMirrored()

  /**
   * Android 15 and later: the system tells the app whether a screen recording can see its windows.
   * The state comes back when a callback is registered, so the callback is removed straight away.
   * Needs the normal DETECT_SCREEN_RECORDING permission (no prompt); without it this reads as false
   * and the display check below still runs.
   */
  private fun isScreenRecorded(): Boolean {
    if (Build.VERSION.SDK_INT < 35) return false
    return runCatching {
        val manager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val callback = Consumer<Int> {}
        val state = manager.addScreenRecordingCallback(context.mainExecutor, callback)
        manager.removeScreenRecordingCallback(callback)
        state == WindowManager.SCREEN_RECORDING_STATE_VISIBLE
      }
      .getOrDefault(false)
  }

  /** Best effort on older Android: a mirrored, cast or presentation display next to the main one. */
  private fun isScreenMirrored(): Boolean {
    val manager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
    val displays = runCatching { manager?.displays }.getOrNull() ?: return false
    return displays.any { display ->
      display.displayId != Display.DEFAULT_DISPLAY &&
        ((display.flags and Display.FLAG_PRESENTATION) != 0 ||
          display.name.contains("virtual", ignoreCase = true) ||
          display.name.contains("cast", ignoreCase = true))
    }
  }

  private fun enabledAccessibilityPackages(): List<String> {
    val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
    val services =
      runCatching {
          manager?.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        }
        .getOrNull() ?: return emptyList()
    return services.mapNotNull { it.resolveInfo?.serviceInfo?.packageName }
  }

  private fun isInstalled(packageName: String): Boolean =
    runCatching { context.packageManager.getPackageInfo(packageName, 0) }.isSuccess

  // ---- Location -------------------------------------------------------------------------

  /** The last known location, only when the app already holds the permission. Never prompts. */
  @Suppress("MissingPermission")
  private fun locationSection(): JSONObject? {
    val granted =
      context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED ||
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
          PackageManager.PERMISSION_GRANTED
    if (!granted) return null

    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
    val newest: Location =
      runCatching {
          manager.getProviders(true).mapNotNull { manager.getLastKnownLocation(it) }
        }
        .getOrNull()
        ?.maxByOrNull { it.time } ?: return null

    @Suppress("DEPRECATION")
    val mock =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) newest.isMock
      else newest.isFromMockProvider

    return JSONObject()
      .put("lat", newest.latitude)
      .put("lng", newest.longitude)
      .put("accuracy_m", newest.accuracy.toDouble())
      .put("is_mock", mock)
  }
}
