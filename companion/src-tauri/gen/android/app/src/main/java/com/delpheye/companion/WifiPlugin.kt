package com.delpheye.companion

import android.Manifest
import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.net.HttpURLConnection
import java.net.URL

@InvokeArg
class HttpArgs {
    lateinit var url: String
    var body: String? = null
}

/**
 * The Wi-Fi the phone hears, from Android's WifiManager. Android hands out scan results only to
 * apps with the location permission, and limits how often a scan may be started (4 per 2 minutes
 * unless "Wi-Fi scan throttling" is off in the developer options); between scans the last results
 * come back, with their age.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location"),
        // Newer Android asks before an app may reach devices on the home network.
        Permission(strings = ["android.permission.NEARBY_WIFI_DEVICES", "android.permission.ACCESS_LOCAL_NETWORK"], alias = "nearby"),
    ],
)
class WifiPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun scan(invoke: Invoke) {
        val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val started = try { wm.startScan() } catch (e: Exception) { false }
        val now = SystemClock.elapsedRealtime() * 1000
        val results = JSArray()
        val list = try { wm.scanResults } catch (e: SecurityException) { emptyList() }
        for (r in list) {
            val o = JSObject()
            o.put("bssid", r.BSSID ?: "")
            @Suppress("DEPRECATION")
            o.put("ssid", r.SSID ?: "")
            o.put("rssi", r.level)
            o.put("freq", r.frequency)
            o.put("age", (now - r.timestamp) / 1000)
            results.put(o)
        }
        val ret = JSObject()
        ret.put("started", started)
        ret.put("device", if (Build.MODEL.startsWith(Build.MANUFACTURER, true)) Build.MODEL else "${Build.MANUFACTURER} ${Build.MODEL}")
        ret.put("results", results)
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo
        if (info != null && info.networkId != -1) {
            ret.put("linkBssid", info.bssid)
            ret.put("linkRssi", info.rssi)
        }
        invoke.resolve(ret)
    }

    /**
     * One request to DelphEye on the computer, sent explicitly over the Wi-Fi network: some phones
     * route an app's traffic over mobile data (even to home addresses) while Wi-Fi is connected.
     */
    @Command
    fun http(invoke: Invoke) {
        val args = invoke.parseArgs(HttpArgs::class.java)
        Thread {
            try {
                val cm = activity.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                @Suppress("DEPRECATION")
                val wifi = cm.allNetworks.firstOrNull { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
                val url = URL(args.url)
                val conn = (wifi?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                conn.useCaches = false
                val body = args.body
                if (body != null) {
                    conn.requestMethod = "POST"
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(body.toByteArray()) }
                }
                val status = conn.responseCode
                val text = (if (status >= 400) conn.errorStream else conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                val ret = JSObject()
                ret.put("status", status)
                ret.put("body", text)
                ret.put("wifi", wifi != null)
                invoke.resolve(ret)
            } catch (e: Exception) {
                invoke.reject(e.toString())
            }
        }.start()
    }
}
