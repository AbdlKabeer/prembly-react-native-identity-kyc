package com.prembly.device

import android.content.Context
import java.io.File
import java.util.UUID

/**
 * The app-scoped device ID. It lives in a file in the app's no-backup directory, so Android's
 * backup and device-to-device restore never copy it to another phone (which would make two devices
 * look like one). Uninstalling the app removes it, so a reinstall gets a new ID.
 */
internal object DeviceIdStore {
  private const val FILE_NAME = "prembly_tm_device_id"

  @Synchronized
  fun deviceId(context: Context): String {
    val file = File(context.noBackupFilesDir, FILE_NAME)
    runCatching {
      if (file.exists()) {
        val stored = file.readText().trim()
        if (stored.isNotEmpty()) return stored
      }
    }

    val fresh = UUID.randomUUID().toString()
    // If the file cannot be written the ID is simply not kept: the next call makes a new one.
    runCatching { file.writeText(fresh) }
    return fresh
  }
}
