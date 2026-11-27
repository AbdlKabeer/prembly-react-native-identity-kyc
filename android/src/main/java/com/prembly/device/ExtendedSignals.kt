package com.prembly.device

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.UserManager
import android.telephony.TelephonyManager
import android.view.accessibility.AccessibilityManager
import java.io.File
import java.net.NetworkInterface
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Locale
import org.json.JSONObject

/**
 * The signals added after the first release: clone apps, device masking, virtual OS, auto-clickers,
 * VPN and GPS spoofers, intercepted connections, call state, USB debugging in progress, and the
 * context of the phone (install source, battery, carrier, wifi, storage, CPU).
 *
 * Every reading is best effort and wrapped, so a phone that refuses one leaves the field out. A field
 * is left out when it cannot be read; it is never sent as `false` just to fill a gap. Nothing here
 * asks for a permission: the wifi name is read only when the app already holds location permission.
 */
internal class ExtendedSignals(private val context: Context) {

  // ---- Device context -----------------------------------------------------------------------

  fun deviceContext(): JSONObject {
    val out = JSONObject()
    installSource()?.let { out.put("install_source", it) }
    Build.SUPPORTED_ABIS?.firstOrNull()?.let { out.put("cpu_architecture", it) }
    storageFreePercent()?.let { out.put("storage_free_percent", it) }
    battery(out)
    carrier(out)
    wifi(out)
    signingCertSha256()?.let { out.put("signing_cert_sha256", it) }
    return out
  }

  private fun installSource(): String? =
    runCatching {
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          pm.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
          @Suppress("DEPRECATION") pm.getInstallerPackageName(context.packageName)
        }
      }
      .getOrNull()
      ?: ""

  private fun storageFreePercent(): Double? =
    runCatching {
        val stat = StatFs(Environment.getDataDirectory().path)
        val total = stat.totalBytes.toDouble()
        if (total <= 0) null else Math.round(stat.availableBytes / total * 1000.0) / 10.0
      }
      .getOrNull()

  private fun batteryIntent(): Intent? =
    runCatching { context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }
      .getOrNull()

  private fun battery(out: JSONObject) {
    val intent = batteryIntent() ?: return
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    if (level >= 0 && scale > 0) out.put("battery_level", level * 100 / scale)
    val health =
      when (intent.getIntExtra(BatteryManager.EXTRA_HEALTH, 0)) {
        BatteryManager.BATTERY_HEALTH_GOOD -> "good"
        BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
        BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
        BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
        BatteryManager.BATTERY_HEALTH_COLD -> "cold"
        BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "failure"
        else -> "unknown"
      }
    out.put("battery_health", health)
    intent.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY)?.takeIf { it.isNotBlank() }?.let {
      out.put("battery_technology", it)
    }
    // Tenths of a degree Celsius, and millivolts, as the system reports them.
    val tenths = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
    if (tenths != Int.MIN_VALUE) out.put("battery_temperature_c", tenths / 10.0)
    val volts = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)
    if (volts > 0) out.put("battery_voltage_mv", volts)
  }

  /** Carrier name, country and network codes need no permission. */
  private fun carrier(out: JSONObject) {
    runCatching {
      val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
      tm.networkOperatorName?.takeIf { it.isNotBlank() }?.let { out.put("carrier_name", it) }
      tm.simCountryIso?.takeIf { it.isNotBlank() }?.let {
        out.put("carrier_country", it.uppercase(Locale.ROOT))
      }
      val code = tm.simOperator ?: ""
      if (code.length >= 5) {
        out.put("carrier_mcc", code.substring(0, 3))
        out.put("carrier_mnc", code.substring(3))
      }
    }
  }

  /**
   * The wifi name and access point. Android hides both unless the app holds location permission, so
   * this reads them only then and never asks. The access point (BSSID) is a MAC address: we send it
   * so the server can hash it, and the server never stores it as sent.
   */
  @Suppress("DEPRECATION", "MissingPermission")
  private fun wifi(out: JSONObject) {
    val granted =
      context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (!granted) return
    runCatching {
      val manager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
          ?: return
      val info = manager.connectionInfo ?: return
      val ssid = info.ssid?.trim('"')
      if (!ssid.isNullOrBlank() && ssid != "<unknown ssid>") out.put("wifi_ssid", ssid)
      val bssid = info.bssid
      if (!bssid.isNullOrBlank() && bssid != "02:00:00:00:00:00") out.put("wifi_bssid", bssid)
    }
  }

  /**
   * SHA-256 of the certificate this install is signed with. The SDK cannot judge it, because it does
   * not know the published certificate. The server compares it with the one registered for the app.
   */
  @Suppress("DEPRECATION")
  private fun signingCertSha256(): String? =
    runCatching {
        val pm = context.packageManager
        val signatures =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
              .signingInfo
              ?.apkContentsSigners
          } else {
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
          }
        val first = signatures?.firstOrNull() ?: return null
        MessageDigest.getInstance("SHA-256").digest(first.toByteArray()).joinToString("") {
          "%02x".format(it)
        }
      }
      .getOrNull()

  // ---- Integrity flags ----------------------------------------------------------------------

  /** The new integrity flags. A flag that cannot be read is left out. */
  fun integrityFlags(): JSONObject {
    val out = JSONObject()
    put(out, "clone_app_detected", ::isCloned)
    put(out, "device_masked", ::isMasked)
    put(out, "virtual_os", ::isVirtualOs)
    put(out, "auto_clicker_enabled", ::autoClickerEnabled)
    put(out, "secondary_user", ::isSecondaryUser)
    put(out, "vpn_spoofer_app_running", ::vpnHidden)
    put(out, "gps_spoofer_app_running", ::gpsSpooferActive)
    put(out, "sdk_connection_intercepted", ::connectionIntercepted)
    put(out, "usb_debugging_in_progress", ::usbDebuggingInProgress)
    return out
  }

  private fun put(out: JSONObject, name: String, read: () -> Boolean?) {
    runCatching { read() }.getOrNull()?.let { out.put(name, it) }
  }

  /** True while a call (including a voice-over-internet call) is in progress. */
  fun onPhoneCall(): Boolean? =
    runCatching {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        audio?.let {
          it.mode == AudioManager.MODE_IN_CALL || it.mode == AudioManager.MODE_IN_COMMUNICATION
        }
      }
      .getOrNull()

  /**
   * Running inside a parallel-space or clone app. An ordinary install keeps its data under
   * /data/user/<id>/<package> (or /data/data/<package>), and runs in a process named after the
   * package. A clone host moves the data and renames the process.
   */
  private fun isCloned(): Boolean? {
    val dataDir = context.applicationInfo.dataDir ?: return null
    val standard = Regex("^/data/(user(_de)?/\\d+|data)/${Regex.escape(context.packageName)}$")
    if (!standard.matches(dataDir)) return true
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val process = android.app.Application.getProcessName()
      // A second process of the app is named "package:something"; a clone host uses a foreign name.
      if (!process.startsWith(context.packageName)) return true
    }
    return SpooferApps.CLONE_HOSTS.any { host -> File(context.applicationInfo.dataDir).path.contains(host) }
  }

  /**
   * The phone's build fields do not agree with each other: its fingerprint names a different brand
   * or device than the fields the app reads. Device-spoofing tools change one and not the other.
   */
  private fun isMasked(): Boolean? {
    val fingerprint = Build.FINGERPRINT ?: return null
    val parts = fingerprint.split('/')
    if (parts.size < 3) return null
    val brand = parts[0]
    val device = parts[2].substringBefore(':')
    val brandMatches =
      brand.equals(Build.BRAND, ignoreCase = true) ||
        brand.equals(Build.MANUFACTURER, ignoreCase = true)
    val deviceMatches = device.equals(Build.DEVICE, ignoreCase = true)
    return !(brandMatches && deviceMatches)
  }

  /** Running inside a virtual machine or container app, not on the phone's own system. */
  private fun isVirtualOs(): Boolean? {
    val maps = runCatching { File("/proc/self/maps").readText() }.getOrNull() ?: return null
    if (SpooferApps.VIRTUAL_OS_MARKERS.any { maps.contains(it, ignoreCase = true) }) return true
    val model = (Build.MODEL ?: "") + " " + (Build.MANUFACTURER ?: "")
    return SpooferApps.VIRTUAL_OS_MARKERS.any { model.contains(it, ignoreCase = true) }
  }

  /**
   * An enabled accessibility service from outside the system that can tap the screen. An
   * auto-clicker has to turn one on to work, and a person's phone rarely has one.
   */
  @Suppress("DEPRECATION")
  private fun autoClickerEnabled(): Boolean? {
    val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
    val services =
      manager?.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        ?: return null
    return services.any { service ->
      val info = service.resolveInfo?.serviceInfo ?: return@any false
      val system = (info.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
      val canTap =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
          (service.capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_PERFORM_GESTURES) != 0
      info.packageName in SpooferApps.AUTO_CLICKERS || (canTap && !system)
    }
  }

  /** The app is running under a second user profile, not the phone's main user. */
  private fun isSecondaryUser(): Boolean? {
    val users = context.getSystemService(Context.USER_SERVICE) as? UserManager ?: return null
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    return !users.isSystemUser
  }

  /**
   * A VPN is carrying traffic but the system says there is none: a tunnel interface is up while the
   * active network has no VPN transport. A tool that hides the VPN from apps leaves exactly this.
   */
  private fun vpnHidden(): Boolean? {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    val capabilities = manager?.getNetworkCapabilities(manager.activeNetwork) ?: return null
    if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return false
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList() ?: return null
    return interfaces.any { it.isUp && SpooferApps.TUNNEL_PREFIXES.any { p -> it.name.startsWith(p) } }
  }

  /**
   * A mock-location app is installed and has been chosen as the phone's mock-location provider.
   * Installed alone proves nothing, so it needs both.
   */
  @Suppress("DEPRECATION")
  private fun gpsSpooferActive(): Boolean? {
    val ops =
      context.getSystemService(Context.APP_OPS_SERVICE) as? android.app.AppOpsManager ?: return null
    return SpooferApps.GPS_SPOOFERS.any { pkg ->
      val uid =
        runCatching { context.packageManager.getApplicationInfo(pkg, 0).uid }.getOrNull()
          ?: return@any false
      ops.checkOpNoThrow("android:mock_location", uid, pkg) == android.app.AppOpsManager.MODE_ALLOWED
    }
  }

  /**
   * Something sits between the app and the network: the user installed a certificate authority (the
   * way an inspecting proxy reads encrypted traffic). A phone with none is the normal case.
   */
  private fun connectionIntercepted(): Boolean? {
    val store = KeyStore.getInstance("AndroidCAStore")
    store.load(null)
    return store.aliases().toList().any { it.startsWith("user:") }
  }

  /** USB debugging is on and a computer is connected over USB right now. */
  @Suppress("DEPRECATION")
  private fun usbDebuggingInProgress(): Boolean? {
    val adb =
      android.provider.Settings.Global.getInt(
        context.contentResolver,
        android.provider.Settings.Global.ADB_ENABLED,
        0,
      ) == 1
    if (!adb) return false
    val plugged = batteryIntent()?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: return null
    return plugged and BatteryManager.BATTERY_PLUGGED_USB != 0
  }

}
