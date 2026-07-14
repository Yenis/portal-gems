package com.gemstech.portalgems

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.google.zxing.integration.android.IntentIntegrator
import java.io.File

/**
 * App-side helpers the Rust engine cannot provide:
 *  - SAF: copy a content:// URI into the app cache so Rust gets a real path
 *  - MediaStore: publish a received file into the public Downloads collection
 *  - Foreground service control for the duration of a transfer
 */
class PortalGemsNativeModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    // IntentIntegrator.REQUEST_CODE is 49374; stay clear of it.
    private const val PICK_DIR_REQUEST = 49375
  }

  private var scanPromise: Promise? = null
  private var pickDirPromise: Promise? = null

  private val activityListener: ActivityEventListener =
    object : BaseActivityEventListener() {
      override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?
      ) {
        if (requestCode == PICK_DIR_REQUEST) {
          val promise = pickDirPromise ?: return
          pickDirPromise = null
          val uri = data?.data
          if (resultCode != Activity.RESULT_OK || uri == null) {
            promise.resolve(null) // user backed out
            return
          }
          try {
            reactApplicationContext.contentResolver.takePersistableUriPermission(
              uri,
              Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
            val label =
              DocumentFile.fromTreeUri(reactApplicationContext, uri)?.name
                ?: uri.lastPathSegment ?: uri.toString()
            promise.resolve(
              WritableNativeMap().apply {
                putString("uri", uri.toString())
                putString("label", label)
              }
            )
          } catch (e: Exception) {
            promise.reject("pick_dir_failed", e.message, e)
          }
          return
        }
        if (requestCode != IntentIntegrator.REQUEST_CODE) return
        val promise = scanPromise ?: return
        scanPromise = null
        val result = IntentIntegrator.parseActivityResult(resultCode, data)
        promise.resolve(result?.contents) // null when the user backed out
      }
    }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  override fun getName() = "PortalGemsNative"

  override fun getConstants(): Map<String, Any> {
    val incoming = File(reactApplicationContext.cacheDir, "incoming").apply { mkdirs() }
    val deviceName =
      Settings.Global.getString(reactApplicationContext.contentResolver, "device_name")
        ?: Build.MODEL
    return mapOf(
      "incomingDir" to incoming.absolutePath,
      "cacheDir" to reactApplicationContext.cacheDir.absolutePath,
      "deviceName" to deviceName,
      "locale" to java.util.Locale.getDefault().language,
    )
  }

  // ---- Plain (non-secret) app settings ----

  private val settingsPrefs by lazy {
    reactApplicationContext.getSharedPreferences("portalgems_settings", 0)
  }

  @ReactMethod
  fun getSetting(key: String, promise: Promise) {
    promise.resolve(settingsPrefs.getString(key, null))
  }

  @ReactMethod
  fun setSetting(key: String, value: String, promise: Promise) {
    settingsPrefs.edit().putString(key, value).apply()
    promise.resolve(null)
  }

  // ---- Pairing secret storage (Android Keystore-backed) ----

  private val pairPrefs by lazy {
    val masterKey = MasterKey.Builder(reactApplicationContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
    EncryptedSharedPreferences.create(
      reactApplicationContext,
      "portalgems_pairs",
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }

  @ReactMethod
  fun getPairedDevices(promise: Promise) {
    try {
      promise.resolve(pairPrefs.getString("devices", "[]"))
    } catch (e: Exception) {
      promise.reject("pairs_read_failed", e.message, e)
    }
  }

  @ReactMethod
  fun setPairedDevices(json: String, promise: Promise) {
    try {
      pairPrefs.edit().putString("devices", json).apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("pairs_write_failed", e.message, e)
    }
  }

  // ---- QR scanning (zxing-android-embedded; no Play Services) ----

  @ReactMethod
  fun scanQr(promise: Promise) {
    val activity: Activity? = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "no current activity")
      return
    }
    if (scanPromise != null) {
      promise.reject("scan_in_progress", "a scan is already in progress")
      return
    }
    scanPromise = promise
    IntentIntegrator(activity)
      .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
      .setBeepEnabled(false)
      .setOrientationLocked(true)
      .initiateScan()
  }

  // ---- Small file helpers for the pairing handshake ----

  @ReactMethod
  fun writeTextFile(dir: String, name: String, content: String, promise: Promise) {
    try {
      val file = File(dir, name)
      file.writeText(content)
      promise.resolve(file.absolutePath)
    } catch (e: Exception) {
      promise.reject("write_text_failed", e.message, e)
    }
  }

  @ReactMethod
  fun readTextFile(path: String, promise: Promise) {
    try {
      promise.resolve(File(path).readText())
    } catch (e: Exception) {
      promise.reject("read_text_failed", e.message, e)
    }
  }

  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    try {
      File(path).delete()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("delete_failed", e.message, e)
    }
  }

  @ReactMethod
  fun copyToCache(uriString: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      val resolver = reactApplicationContext.contentResolver

      var name = "shared.bin"
      var size = -1L
      resolver.query(uri, null, null, null, null)?.use { cursor ->
        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (cursor.moveToFirst()) {
          if (nameIdx >= 0) cursor.getString(nameIdx)?.let { name = it }
          if (sizeIdx >= 0) size = cursor.getLong(sizeIdx)
        }
      }

      val outDir = File(reactApplicationContext.cacheDir, "outgoing").apply { mkdirs() }
      val outFile = File(outDir, name)
      resolver.openInputStream(uri).use { input ->
        requireNotNull(input) { "could not open input stream" }
        outFile.outputStream().use { output -> input.copyTo(output) }
      }

      val result = WritableNativeMap().apply {
        putString("path", outFile.absolutePath)
        putString("name", name)
        putDouble("size", if (size >= 0) size.toDouble() else outFile.length().toDouble())
      }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("copy_to_cache_failed", e.message, e)
    }
  }

  @ReactMethod
  fun saveToDownloads(srcPath: String, fileName: String, promise: Promise) {
    try {
      val src = File(srcPath)
      require(src.exists()) { "source file does not exist: $srcPath" }
      promise.resolve(publishToDownloads(src, fileName))
    } catch (e: Exception) {
      promise.reject("save_to_downloads_failed", e.message, e)
    }
  }

  /** Publish `src` into the public Downloads collection; returns the final
   *  display name (MediaStore/legacy dedup may adjust it). Deletes `src`. */
  private fun publishToDownloads(src: File, fileName: String): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val resolver = reactApplicationContext.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, fileName)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("MediaStore insert failed")
      resolver.openOutputStream(uri).use { output ->
        requireNotNull(output) { "could not open output stream" }
        src.inputStream().use { input -> input.copyTo(output) }
      }
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)

      // Query back the display name MediaStore actually used (it de-dupes).
      var finalName = fileName
      resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0)?.let { finalName = it } }
      src.delete()
      return finalName
    } else {
      @Suppress("DEPRECATION")
      val downloads =
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
      downloads.mkdirs()
      var dest = File(downloads, fileName)
      var n = 1
      while (dest.exists()) {
        val dot = fileName.lastIndexOf('.')
        val stem = if (dot > 0) fileName.substring(0, dot) else fileName
        val ext = if (dot > 0) fileName.substring(dot) else ""
        dest = File(downloads, "$stem ($n)$ext")
        n++
      }
      src.inputStream().use { input -> dest.outputStream().use { input.copyTo(it) } }
      src.delete()
      return dest.name
    }
  }

  // ---- User-chosen download folder (SAF tree) ----

  @ReactMethod
  fun pickDownloadDirectory(promise: Promise) {
    val activity: Activity? = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "no current activity")
      return
    }
    if (pickDirPromise != null) {
      promise.reject("pick_in_progress", "a folder pick is already in progress")
      return
    }
    pickDirPromise = promise
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
      )
      activity.startActivityForResult(intent, PICK_DIR_REQUEST)
    } catch (e: Exception) {
      pickDirPromise = null
      promise.reject("pick_dir_failed", e.message, e)
    }
  }

  @ReactMethod
  fun releaseDownloadDirectory(uriString: String, promise: Promise) {
    try {
      reactApplicationContext.contentResolver.releasePersistableUriPermission(
        Uri.parse(uriString),
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
    } catch (_: Exception) {
      // already released or never granted - nothing to do
    }
    promise.resolve(null)
  }

  /** The chosen tree as a writable directory, or null when it was deleted or
   *  its permission revoked (a SAF tree cannot be recreated from here - we
   *  hold no grant on its parent - so callers fall back to Downloads). */
  private fun openTreeDir(uriString: String): DocumentFile? =
    try {
      DocumentFile.fromTreeUri(reactApplicationContext, Uri.parse(uriString))
        ?.takeIf { it.isDirectory && it.canWrite() }
    } catch (e: Exception) {
      null
    }

  @ReactMethod
  fun statDownloadTarget(dirUri: String, fileName: String, promise: Promise) {
    try {
      val dir = openTreeDir(dirUri)
      val existing = dir?.findFile(fileName)?.takeIf { it.isFile }
      promise.resolve(
        WritableNativeMap().apply {
          putBoolean("dirOk", dir != null)
          putBoolean("exists", existing != null)
          putDouble("size", existing?.length()?.toDouble() ?: 0.0)
        }
      )
    } catch (e: Exception) {
      promise.reject("stat_target_failed", e.message, e)
    }
  }

  @ReactMethod
  fun saveToDownloadDir(
    srcPath: String,
    dirUri: String,
    fileName: String,
    overwrite: Boolean,
    promise: Promise,
  ) {
    try {
      val src = File(srcPath)
      require(src.exists()) { "source file does not exist: $srcPath" }

      val dir = openTreeDir(dirUri)
      if (dir == null) {
        val name = publishToDownloads(src, fileName)
        promise.resolve(
          WritableNativeMap().apply {
            putString("name", name)
            putBoolean("fallback", true)
          }
        )
        return
      }

      var targetName = fileName
      val existing = dir.findFile(fileName)
      if (existing != null) {
        if (overwrite) {
          // `src` is already fully received (staged in the app cache), so the
          // user's existing file is only replaced now - a failed transfer
          // never gets this far and leaves it untouched.
          existing.delete()
        } else {
          val dot = fileName.lastIndexOf('.')
          val stem = if (dot > 0) fileName.substring(0, dot) else fileName
          val ext = if (dot > 0) fileName.substring(dot) else ""
          var n = 1
          while (dir.findFile(targetName) != null) {
            targetName = "$stem ($n)$ext"
            n++
          }
        }
      }

      // Mime from the extension, else the provider may append its own (.bin).
      val ext = targetName.substringAfterLast('.', "")
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase())
        ?: "application/octet-stream"
      val out = dir.createFile(mime, targetName)
        ?: throw IllegalStateException("could not create file in the chosen folder")
      reactApplicationContext.contentResolver.openOutputStream(out.uri).use { output ->
        requireNotNull(output) { "could not open output stream" }
        src.inputStream().use { input -> input.copyTo(output) }
      }
      src.delete()
      promise.resolve(
        WritableNativeMap().apply {
          putString("name", out.name ?: targetName)
          putBoolean("fallback", false)
        }
      )
    } catch (e: Exception) {
      promise.reject("save_to_dir_failed", e.message, e)
    }
  }

  @ReactMethod
  fun consumePendingShare(promise: Promise) {
    val uri = MainActivity.pendingShareUri
    MainActivity.pendingShareUri = null
    promise.resolve(uri)
  }

  @ReactMethod
  fun startTransferService(title: String, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent = Intent(ctx, TransferService::class.java).putExtra("title", title)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("service_start_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stopTransferService(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      ctx.stopService(Intent(ctx, TransferService::class.java))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("service_stop_failed", e.message, e)
    }
  }
}
