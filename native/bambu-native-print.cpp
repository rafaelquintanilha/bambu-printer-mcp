#include <dlfcn.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <map>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <sstream>
#include <string>
#include <sys/stat.h>
#if !defined(__APPLE__)
#include <pwd.h>
#include <unistd.h>
#endif
#include <thread>
#include <vector>
#if defined(__APPLE__)
void configureCloudIdentity(const std::string &studioPath, const std::string &pluginPath);
#endif

// This small adapter intentionally mirrors the public C++ ABI declarations
// used by Bambu Studio's optional networking plug-in.  The plug-in is loaded
// at runtime, so the MCP remains usable on machines without Bambu Studio.
namespace BBL {

using OnLocalConnectedFn = std::function<void(int, std::string, std::string)>;
using OnUpdateStatusFn = std::function<void(int, int, std::string)>;
using WasCancelledFn = std::function<bool()>;

struct PrintParams {
    std::string dev_id;
    std::string task_name;
    std::string project_name;
    std::string preset_name;
    std::string filename;
    std::string config_filename;
    int plate_index = 0;
    std::string ftp_folder;
    std::string ftp_file;
    std::string ftp_file_md5;
    std::string nozzle_mapping;
    std::string ams_mapping;
    std::string ams_mapping2;
    std::string ams_mapping_info;
    std::string nozzles_info;
    std::string connection_type;
    std::string comments;
    int origin_profile_id = 0;
    int stl_design_id = 0;
    std::string origin_model_id;
    std::string print_type;
    std::string dst_file;
    std::string dev_name;
    std::string dev_ip;
    bool use_ssl_for_ftp = true;
    bool use_ssl_for_mqtt = true;
    std::string username;
    std::string password;
    bool task_bed_leveling = true;
    bool task_flow_cali = true;
    bool task_vibration_cali = true;
    bool task_layer_inspect = false;
    bool task_record_timelapse = false;
    bool task_timelapse_use_internal = false;
    bool task_use_ams = true;
    std::string task_bed_type;
    std::string extra_options;
    int auto_bed_leveling = 0;
    int auto_flow_cali = 0;
    int auto_offset_cali = 0;
    int extruder_cali_manual_mode = -1;
    bool task_ext_change_assist = false;
    bool try_emmc_print = true;
    std::string svc_context;
    std::string slicer_uid;
    std::string queue_plate_id;
};

} // namespace BBL

namespace {

using FtErr = int;
struct FT_TunnelHandle;
using FtAbiVersionFn = int (*)();
using FtTunnelCreateFn = FtErr (*)(const char *, FT_TunnelHandle **);
using FtTunnelSyncConnectFn = FtErr (*)(FT_TunnelHandle *);
using FtTunnelReleaseFn = void (*)(FT_TunnelHandle *);

using CreateAgentFn = void *(*)(std::string);
using DestroyAgentFn = int (*)(void *);
using InitLogFn = int (*)(void *);
using SetConfigDirFn = int (*)(void *, std::string);
using SetCertFileFn = int (*)(void *, std::string, std::string);
using SetCountryCodeFn = int (*)(void *, std::string);
using StartFn = int (*)(void *);
using SetLocalConnectFn = int (*)(void *, BBL::OnLocalConnectedFn);
using SetPrinterConnectedFn = int (*)(void *, std::function<void(std::string)>);
using SetMessageFn = int (*)(void *, std::function<void(std::string, std::string)>);
using SetLocalMessageFn = int (*)(void *, std::function<void(std::string, std::string)>);
using SetQueueOnMainFn = int (*)(void *, std::function<void(std::function<void()>)>);
using ConnectPrinterFn = int (*)(void *, std::string, std::string, std::string, std::string, bool);
using SendMessageToPrinterFn = int (*)(void *, std::string, std::string, int, int);
using InstallDeviceCertFn = void (*)(void *, std::string, bool);
using UpdateCertFn = int (*)(void *);
using StartLocalPrintFn = int (*)(void *, BBL::PrintParams, BBL::OnUpdateStatusFn, BBL::WasCancelledFn);
using StartSendGcodeToSdcardFn = int (*)(void *, BBL::PrintParams, BBL::OnUpdateStatusFn, BBL::WasCancelledFn, std::function<bool(int, std::string)>);

std::mutex output_mutex;

void outputLine(const std::string &line) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << line << std::endl;
}

// End a one-shot run once the plug-in's own cleanup (destroy_agent) is done.
// Its worker threads can outlive that cleanup; process-exit destructors and
// dlclose then crashed successful command, upload and probe runs with SIGSEGV
// on Linux. Flush the protocol output and let the OS reclaim the rest.
[[noreturn]] void exitNow(int code) {
    std::cout.flush();
    std::cerr.flush();
    std::_Exit(code);
}

std::string envOr(const char *name, const std::string &fallback = {}) {
    const char *value = std::getenv(name);
    return value && *value ? std::string(value) : fallback;
}

// Cloud failure messages look like "upload_3mf_config failed(<n>),code=<http>,
// body=<response>". The body and any URL can carry signed storage or account
// data, so report only the step name and the two numbers.
std::string cloudFailureSummary(int status, int code, const std::string &message) {
    static const std::regex step(R"(^([a-z0-9_]{1,48}) failed)");
    static const std::regex detail(R"(^[a-z0-9_]{1,48} failed\((-?[0-9]{1,9})\))");
    static const std::regex http(R"(^[a-z0-9_]{1,48} failed(?:\(-?[0-9]{1,9}\))?,code=(-?[0-9]{1,9}))");
    std::smatch match;
    std::string summary = "native_cloud_failure status=" + std::to_string(status) + " code=" + std::to_string(code);
    summary += " step=" + (std::regex_search(message, match, step) ? match[1].str() : std::string("unknown"));
    if (std::regex_search(message, match, detail)) summary += " detail=" + match[1].str();
    if (std::regex_search(message, match, http)) summary += " http=" + match[1].str();
    return summary;
}

std::string homeDir() {
#if defined(__APPLE__)
    return envOr("HOME", "/Users/Shared");
#else
    // Match Node's os.homedir() so the server and helper agree without HOME.
    const std::string home = envOr("HOME");
    if (!home.empty()) return home;
    const passwd *entry = getpwuid(getuid());
    return entry && entry->pw_dir ? std::string(entry->pw_dir) : std::string("/");
#endif
}

#if defined(__APPLE__)
bool isRegularFile(const std::string &path) {
    struct stat fileStat {};
    return stat(path.c_str(), &fileStat) == 0 && S_ISREG(fileStat.st_mode);
}

std::string defaultPluginPath() {
    // Bambu Connect ships the current X2D networking plug-in. Prefer it when
    // present; older Bambu Studio installations remain a compatible fallback.
    const std::string connectPlugin =
        "/Applications/Bambu Connect.app/Contents/Resources/app.asar.unpacked/plugins/plugins-mac/libbambu_networking.dylib";
    if (isRegularFile(connectPlugin)) return connectPlugin;
    return homeDir() + "/Library/Application Support/BambuStudio/plugins/libbambu_networking.dylib";
}

std::string defaultConfigDir() {
    return envOr("BAMBU_NATIVE_CONFIG_DIR", homeDir() + "/Library/Application Support/BambuStudio");
}

std::string defaultCertDir() {
    return envOr("BAMBU_NATIVE_CERT_DIR", "/Applications/BambuStudio.app/Contents/Resources/cert");
}


#else
// Linux has no application bundle to borrow from. The setup script installs a
// pinned plug-in and certificates under one private directory. The server
// passes the resolved paths explicitly; these defaults only serve direct use
// and mirror bambuNativeManagedPaths() in src/bambu-native.ts.
std::string nativeHomeDir() {
    const std::string configured = envOr("BAMBU_NATIVE_HOME");
    if (!configured.empty()) return configured;
    return envOr("XDG_CONFIG_HOME", homeDir() + "/.config") + "/bambu-printer-mcp/bambu-native";
}

std::string defaultPluginPath() {
    // Only the pinned plug-in: Bambu Studio's own copy auto-updates and its
    // PrintParams layout is not checked against this helper.
    return nativeHomeDir() + "/plugins/libbambu_networking.so";
}

std::string defaultConfigDir() {
    return envOr("BAMBU_NATIVE_CONFIG_DIR", nativeHomeDir() + "/config");
}

std::string defaultCertDir() {
    return envOr("BAMBU_NATIVE_CERT_DIR", nativeHomeDir() + "/cert");
}
#endif

void *symbol(void *handle, const char *name) {
    return dlsym(handle, name);
}

template <typename T>
T requiredSymbol(void *handle, const char *name) {
    dlerror();
    void *raw = symbol(handle, name);
    const char *error = dlerror();
    if (!raw || error) {
        throw std::runtime_error(std::string("missing native symbol ") + name +
                                 (error ? std::string(": ") + error : std::string()));
    }
    return reinterpret_cast<T>(raw);
}

struct NativeApi {
    void *handle = nullptr;
    CreateAgentFn createAgent = nullptr;
    DestroyAgentFn destroyAgent = nullptr;
    InitLogFn initLog = nullptr;
    SetConfigDirFn setConfigDir = nullptr;
    SetCertFileFn setCertFile = nullptr;
    SetCountryCodeFn setCountryCode = nullptr;
    StartFn start = nullptr;
    SetLocalConnectFn setLocalConnect = nullptr;
    SetPrinterConnectedFn setPrinterConnected = nullptr;
    SetMessageFn setMessage = nullptr;
    SetLocalMessageFn setLocalMessage = nullptr;
    SetQueueOnMainFn setQueueOnMain = nullptr;
    ConnectPrinterFn connectPrinter = nullptr;
    SendMessageToPrinterFn sendMessageToPrinter = nullptr;
    InstallDeviceCertFn installDeviceCert = nullptr;
    UpdateCertFn updateCert = nullptr;
    StartLocalPrintFn startLocalPrint = nullptr;
    FtAbiVersionFn ftAbiVersion = nullptr;
    FtTunnelCreateFn ftTunnelCreate = nullptr;
    FtTunnelSyncConnectFn ftTunnelSyncConnect = nullptr;
    FtTunnelReleaseFn ftTunnelRelease = nullptr;
    StartSendGcodeToSdcardFn startSendGcodeToSdcard = nullptr;

    ~NativeApi() {
        if (handle) dlclose(handle);
    }
};

NativeApi loadApi() {
    const std::string plugin = envOr("BAMBU_NATIVE_PLUGIN", defaultPluginPath());
    void *handle = dlopen(plugin.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        const char *error = dlerror();
        throw std::runtime_error("could not load Bambu networking plug-in: " + plugin +
                                 (error ? std::string(" (") + error + ")" : std::string()));
    }

    NativeApi api;
    api.handle = handle;
    api.createAgent = requiredSymbol<CreateAgentFn>(handle, "bambu_network_create_agent");
    api.destroyAgent = requiredSymbol<DestroyAgentFn>(handle, "bambu_network_destroy_agent");
    api.initLog = requiredSymbol<InitLogFn>(handle, "bambu_network_init_log");
    api.setConfigDir = requiredSymbol<SetConfigDirFn>(handle, "bambu_network_set_config_dir");
    api.setCertFile = requiredSymbol<SetCertFileFn>(handle, "bambu_network_set_cert_file");
    api.setCountryCode = requiredSymbol<SetCountryCodeFn>(handle, "bambu_network_set_country_code");
    api.start = requiredSymbol<StartFn>(handle, "bambu_network_start");
    api.setLocalConnect = requiredSymbol<SetLocalConnectFn>(handle, "bambu_network_set_on_local_connect_fn");
    api.setPrinterConnected = requiredSymbol<SetPrinterConnectedFn>(handle, "bambu_network_set_on_printer_connected_fn");
    api.setMessage = requiredSymbol<SetMessageFn>(handle, "bambu_network_set_on_message_fn");
    api.setLocalMessage = requiredSymbol<SetLocalMessageFn>(handle, "bambu_network_set_on_local_message_fn");
    api.setQueueOnMain = requiredSymbol<SetQueueOnMainFn>(handle, "bambu_network_set_queue_on_main_fn");
    api.connectPrinter = requiredSymbol<ConnectPrinterFn>(handle, "bambu_network_connect_printer");
    api.sendMessageToPrinter = requiredSymbol<SendMessageToPrinterFn>(handle, "bambu_network_send_message_to_printer");
    api.installDeviceCert = requiredSymbol<InstallDeviceCertFn>(handle, "bambu_network_install_device_cert");
    api.updateCert = requiredSymbol<UpdateCertFn>(handle, "bambu_network_update_cert");
    api.startLocalPrint = requiredSymbol<StartLocalPrintFn>(handle, "bambu_network_start_local_print");
    api.startSendGcodeToSdcard = requiredSymbol<StartSendGcodeToSdcardFn>(handle, "bambu_network_start_send_gcode_to_sdcard");
    api.ftAbiVersion = requiredSymbol<FtAbiVersionFn>(handle, "ft_abi_version");
    api.ftTunnelCreate = requiredSymbol<FtTunnelCreateFn>(handle, "ft_tunnel_create");
    api.ftTunnelSyncConnect = requiredSymbol<FtTunnelSyncConnectFn>(handle, "ft_tunnel_sync_connect");
    api.ftTunnelRelease = requiredSymbol<FtTunnelReleaseFn>(handle, "ft_tunnel_release");
    return api;
}

std::string localUrl(const std::string &host, const std::string &token) {
    return "bambu:///local/" + host + "?port=6000&user=bblp&passwd=" + token;
}

struct LocalConnectionState {
    std::mutex mutex;
    std::condition_variable cv;
    bool resolved = false;
    bool ok = false;
    int status = -1;
    std::string message;
};

bool boolEnv(const char *name, bool fallback);

void runProbe(NativeApi &api) {
    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    if (host.empty() || token.empty()) {
        throw std::runtime_error("BAMBU_NATIVE_HOST and BAMBU_NATIVE_ACCESS_CODE are required for --probe");
    }

    // Avoid calling the C++ string-returning symbol in the probe. The tunnel
    // API is C ABI and is the only part needed to verify the X2D route.
    const std::string configDir = defaultConfigDir();
    const std::string certDir = defaultCertDir();
    const std::string certFile = envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer");
    void *agent = api.createAgent(configDir);
    if (!agent) throw std::runtime_error("bambu_network_create_agent returned null in probe");
    int agentResult = api.setConfigDir(agent, configDir);
    if (agentResult == 0) agentResult = api.initLog(agent);
    if (agentResult == 0) agentResult = api.setCertFile(agent, certDir, certFile);
    if (agentResult == 0) agentResult = api.setCountryCode(agent, envOr("BAMBU_NATIVE_COUNTRY", "US"));
    if (agentResult == 0) agentResult = api.start(agent);
    const std::string version = "plugin-loaded";
    const int abi = api.ftAbiVersion();
    FT_TunnelHandle *tunnel = nullptr;
    const FtErr createResult = api.ftTunnelCreate(localUrl(host, token).c_str(), &tunnel);
    if (createResult != 0 || !tunnel) {
        outputLine("probe=failed stage=tunnel_create result=" + std::to_string(createResult));
        api.destroyAgent(agent);
        exitNow(22);
    }

    const FtErr connectResult = api.ftTunnelSyncConnect(tunnel);
    api.ftTunnelRelease(tunnel);
    api.destroyAgent(agent);
    outputLine("probe=local_tunnel version=" + version + " ft_abi=" + std::to_string(abi) +
               " connect_result=" + std::to_string(connectResult));
    if (connectResult != 0) exitNow(22);
}

void runMqttProbe(NativeApi &api) {
    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    const std::string serial = envOr("BAMBU_NATIVE_SERIAL");
    if (host.empty() || token.empty() || serial.empty()) {
        throw std::runtime_error("BAMBU_NATIVE_HOST, BAMBU_NATIVE_ACCESS_CODE, and BAMBU_NATIVE_SERIAL are required for --probe-mqtt");
    }

    const std::string configDir = defaultConfigDir();
    const std::string certDir = defaultCertDir();
    const std::string certFile = envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer");
    void *agent = api.createAgent(configDir);
    if (!agent) throw std::runtime_error("bambu_network_create_agent returned null in MQTT probe");
    const auto destroyAgent = [&]() { api.destroyAgent(agent); };

    int result = api.setConfigDir(agent, configDir);
    if (result == 0) result = api.initLog(agent);
    if (result == 0) result = api.setCertFile(agent, certDir, certFile);
    if (result == 0) result = api.setCountryCode(agent, envOr("BAMBU_NATIVE_COUNTRY", "US"));
    if (result == 0) result = api.start(agent);
    if (result != 0) {
        destroyAgent();
        throw std::runtime_error("MQTT probe setup failed: " + std::to_string(result));
    }
    result = api.setQueueOnMain(agent, [](std::function<void()> callback) {
        if (callback) callback();
    });
    if (result != 0) {
        destroyAgent();
        throw std::runtime_error("set_queue_on_main_fn failed in MQTT probe: " + std::to_string(result));
    }

    auto localConnection = std::make_shared<LocalConnectionState>();
    // Bambu Studio installs the printer's application certificate after the
    // networking plug-in reports the printer connected. Without this call the
    // plug-in can upload to eMMC but cannot encrypt the project_file command
    // and returns -4030 (missing device_pub_key_map).
    const int printerCallbackResult = api.setPrinterConnected(
        agent,
        [agent, serial, &api](std::string devId) {
            if (devId.empty() || devId == serial) {
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial);
            }
        });
    if (printerCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_printer_connected_fn failed: " + std::to_string(printerCallbackResult));
    }
    const int messageCallbackResult = api.setMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            outputLine("native_message dev=" + devId + " msg=" + message);
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (messageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_message_fn failed in MQTT probe: " + std::to_string(messageCallbackResult));
    }
    const int localMessageCallbackResult = api.setLocalMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                outputLine("native_local_message dev=" + devId + " msg=wait_info");
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (localMessageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_message_fn failed in MQTT probe: " + std::to_string(localMessageCallbackResult));
    }
    result = api.updateCert(agent);
    outputLine("native_update_cert result=" + std::to_string(result));
    const int callbackResult = api.setLocalConnect(agent, [localConnection, serial](int status, std::string devId, std::string message) {
        outputLine("mqtt_probe_connect status=" + std::to_string(status) + " dev=" + devId + " msg=" + message);
        if (!devId.empty() && devId != serial) return;
        {
            std::lock_guard<std::mutex> lock(localConnection->mutex);
            localConnection->resolved = true;
            localConnection->ok = status == 0;
            localConnection->status = status;
            localConnection->message = std::move(message);
        }
        localConnection->cv.notify_all();
    });
    if (callbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_connect_fn failed in MQTT probe: " + std::to_string(callbackResult));
    }
    result = api.connectPrinter(agent, serial, host, "bblp", token, true);
    if (result != 0) {
        destroyAgent();
        throw std::runtime_error("connect_printer failed in MQTT probe: " + std::to_string(result));
    }

    std::unique_lock<std::mutex> lock(localConnection->mutex);
    const bool resolved = localConnection->cv.wait_for(
        lock,
        std::chrono::seconds(10),
        [&localConnection]() { return localConnection->resolved; });
    if (!resolved) {
        lock.unlock();
        destroyAgent();
        throw std::runtime_error("MQTT probe timed out waiting for local-connect callback");
    }
    const int status = localConnection->status;
    const std::string message = localConnection->message;
    const bool ok = localConnection->ok;
    lock.unlock();
    destroyAgent();
    outputLine("probe=mqtt status=" + std::to_string(status) +
               (message.empty() ? std::string{} : " message=" + message));
    exitNow(ok ? 0 : 21);
}

std::string bedTypeForNative(const std::string &bedType) {
    if (bedType == "textured_plate" || bedType == "pte") return "pte";
    if (bedType == "cool_plate" || bedType == "pc") return "pc";
    if (bedType == "engineering_plate" || bedType == "pe") return "pe";
    if (bedType == "hot_plate" || bedType == "pei") return "pei";
    if (bedType == "supertack_plate" || bedType == "suprtack") return "suprtack";
    return bedType;
}

int intEnv(const char *name, int fallback) {
    const std::string value = envOr(name);
    if (value.empty()) return fallback;
    try {
        return std::stoi(value);
    } catch (...) {
        return fallback;
    }
}

bool boolEnv(const char *name, bool fallback) {
    const std::string value = envOr(name);
    if (value.empty()) return fallback;
    return value == "1" || value == "true" || value == "TRUE" || value == "yes";
}

void requestPrinterState(NativeApi &api, void *agent, const std::string &serial) {
    const int pushAll = api.sendMessageToPrinter(
        agent,
        serial,
        R"({"pushing":{"sequence_id":"1","command":"pushall","version":1,"push_target":1}})",
        0,
        0);
    outputLine("native_request command=pushall result=" + std::to_string(pushAll));

    const int version = api.sendMessageToPrinter(
        agent,
        serial,
        R"({"info":{"sequence_id":"2","command":"get_version"}})",
        1,
        0);
    outputLine("native_request command=get_version result=" + std::to_string(version));

    const int accessCode = api.sendMessageToPrinter(
        agent,
        serial,
        R"({"system":{"sequence_id":"3","command":"get_access_code"}})",
        0,
        0);
    outputLine("native_request command=get_access_code result=" + std::to_string(accessCode));
}

enum class NativeOperation {
    Print,
    CloudPrint,
    Upload,
    Command,
    AuthorizedCommand,
};

void *createCloudAgent(const NativeApi &api);

void runOperation(NativeApi &api, NativeOperation operation) {
    const bool cloud = operation == NativeOperation::CloudPrint;
    const bool uploadOnly = operation == NativeOperation::Upload;
    const bool commandOnly = operation == NativeOperation::Command || operation == NativeOperation::AuthorizedCommand;
    const bool needsAuthorization = operation == NativeOperation::Print || cloud || operation == NativeOperation::AuthorizedCommand;
    const char *confirmation = commandOnly ? "BAMBU_NATIVE_COMMAND_CONFIRM" :
                               uploadOnly ? "BAMBU_NATIVE_UPLOAD_CONFIRM" : "BAMBU_NATIVE_CONFIRM";
    if (envOr(confirmation) != "1") {
        throw std::runtime_error(std::string("refusing native ") +
                                 (commandOnly ? "command" : uploadOnly ? "upload" : "print") +
                                 " without " + confirmation + "=1");
    }

    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    const std::string serial = envOr("BAMBU_NATIVE_SERIAL");
    const std::string file = envOr("BAMBU_NATIVE_FILE");
    const std::string commandJson = envOr("BAMBU_NATIVE_COMMAND_JSON");
    if (host.empty() || token.empty() || serial.empty() ||
        (commandOnly ? commandJson.empty() : file.empty())) {
        throw std::runtime_error(std::string("native ") +
                                 (commandOnly ? "command" : uploadOnly ? "upload" : "print") +
                                 (commandOnly ? " requires host, access code, serial, and command JSON" :
                                                " requires host, access code, serial, and file"));
    }
    struct stat fileStat {};
    if (!commandOnly && (stat(file.c_str(), &fileStat) != 0 || !S_ISREG(fileStat.st_mode))) {
        throw std::runtime_error(std::string("native ") + (uploadOnly ? "upload" : "print") +
                                 " file is not readable: " + file);
    }

    const std::string configDir = defaultConfigDir();
    const std::string certDir = defaultCertDir();
    const std::string certFile = envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer");
    const std::string country = envOr("BAMBU_NATIVE_COUNTRY", "US");

    void *agent = cloud ? createCloudAgent(api) : api.createAgent(configDir);
    if (!agent) throw std::runtime_error("bambu_network_create_agent returned null");
    const auto destroyAgent = [&]() { api.destroyAgent(agent); };

    const auto authorizeDispatch = [&](int attempt) {
        if (!needsAuthorization) return;
        // Connection/certificate setup and retries can outlive the original
        // preflight. The parent owns the shared safety parser and must approve
        // fresh state at this exact dispatch boundary, on every attempt.
        outputLine("native_dispatch_request=" + std::to_string(attempt));
        std::string authorization;
        if (!std::getline(std::cin, authorization) ||
            authorization != "native_dispatch_authorized=" + std::to_string(attempt)) {
            destroyAgent();
            throw std::runtime_error("native dispatch authorization was missing or rejected");
        }
    };

    int result = 0;
    if (!cloud) {
    result = api.setConfigDir(agent, configDir);
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_config_dir failed: " + std::to_string(result)); }
    result = api.initLog(agent);
    if (result != 0) { destroyAgent(); throw std::runtime_error("init_log failed: " + std::to_string(result)); }
    result = api.setCertFile(agent, certDir, certFile);
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_cert_file failed: " + std::to_string(result)); }
    result = api.setCountryCode(agent, country);
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_country_code failed: " + std::to_string(result)); }
    result = api.start(agent);
    if (result != 0) { destroyAgent(); throw std::runtime_error("network start failed: " + std::to_string(result)); }

    result = api.setQueueOnMain(agent, [](std::function<void()> callback) {
        if (callback) callback();
    });
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_queue_on_main_fn failed: " + std::to_string(result)); }

    auto localConnection = std::make_shared<LocalConnectionState>();
    const int printerCallbackResult = api.setPrinterConnected(
        agent,
        [agent, serial, &api](std::string devId) {
            if (devId.empty() || devId == serial) {
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=printer_connected");
            }
        });
    if (printerCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_printer_connected_fn failed: " + std::to_string(printerCallbackResult));
    }
    const int callbackResult = api.setLocalConnect(agent, [localConnection, serial, agent, &api](int status, std::string devId, std::string message) {
        outputLine("native_connect status=" + std::to_string(status) + " dev=" + devId + " msg=" + message);
        if (!devId.empty() && devId != serial) return;
        if (status == 0) {
            // The local-connect callback is the point at which Bambu Studio
            // installs the device certificate for LAN-only printers.
            api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
            outputLine("native_install_device_cert dev=" + serial + " stage=local_connect");
        }
        {
            std::lock_guard<std::mutex> lock(localConnection->mutex);
            localConnection->resolved = true;
            localConnection->ok = status == 0;
            localConnection->status = status;
            localConnection->message = std::move(message);
        }
        localConnection->cv.notify_all();
    });
    if (callbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_connect_fn failed: " + std::to_string(callbackResult));
    }
    const int messageCallbackResult = api.setMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                outputLine("native_message dev=" + devId + " msg=wait_info");
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (messageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_message_fn failed: " + std::to_string(messageCallbackResult));
    }
    const int localMessageCallbackResult = api.setLocalMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            // GUI_App::process_network_msg handles this exact signal by
            // installing the device certificate again. The plug-in emits it
            // after the async app-key request, which is the point where its
            // device_pub_key_map becomes usable for project_file.
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                outputLine("native_local_message dev=" + devId + " msg=wait_info");
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (localMessageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_message_fn failed: " + std::to_string(localMessageCallbackResult));
    }
    result = api.updateCert(agent);
    outputLine("native_update_cert result=" + std::to_string(result));
    result = api.connectPrinter(agent, serial, host, "bblp", token, true);
    if (result != 0) { destroyAgent(); throw std::runtime_error("connect_printer failed: " + std::to_string(result)); }

    // Some plug-in builds emit the local-connect callback without emitting the
    // printer-connected callback. Request installation explicitly as well;
    // the operation is idempotent and is required before encrypted printing.
    api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
    outputLine("native_install_device_cert dev=" + serial);
    result = api.updateCert(agent);
    outputLine("native_update_cert result=" + std::to_string(result) + " stage=connected");

    // connect_printer starts the MQTT loop asynchronously. Calling
    // start_local_print immediately races the CONNACK and makes the plug-in
    // report -4030 (publish MQTT message failed), even though the credentials
    // and the printer are valid. Wait for the local-connect callback before
    // handing the job to the plug-in.
    {
        std::unique_lock<std::mutex> lock(localConnection->mutex);
        const bool resolved = localConnection->cv.wait_for(
            lock,
            std::chrono::seconds(10),
            [&localConnection]() { return localConnection->resolved; });
        if (!resolved) {
            lock.unlock();
            destroyAgent();
            throw std::runtime_error(std::string("local MQTT connection timed out before native ") +
                                     (commandOnly ? "command" : uploadOnly ? "upload" : "print"));
        }
        if (!localConnection->ok) {
            const int status = localConnection->status;
            const std::string message = localConnection->message;
            lock.unlock();
            destroyAgent();
            throw std::runtime_error(
                std::string("local MQTT connection failed before native ") +
                (commandOnly ? "command" : uploadOnly ? "upload" : "print") +
                " status=" + std::to_string(status) +
                (message.empty() ? std::string{} : " message=" + message));
        }
    }

    // GUI_App sends these immediately after a printer connects. They prompt
    // the device to publish its complete state and security metadata before
    // the encrypted project_file message is built.
    requestPrinterState(api, agent, serial);

    // Allow the asynchronous certificate exchange and device-public-key map
    // update to complete before start_local_print publishes project_file.
    if (commandOnly) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        const int qos = std::clamp(intEnv("BAMBU_NATIVE_COMMAND_QOS", 0), 0, 1);
        const int flag = std::clamp(intEnv("BAMBU_NATIVE_COMMAND_FLAG", 0), 0, 1);
        authorizeDispatch(1);
        result = api.sendMessageToPrinter(agent, serial, commandJson, qos, flag);
        if (result == -4030 || result == -4) {
            // A protected control may be the first command that asks the
            // printer for its public key. A non-zero synchronous return means
            // it was not queued, so one guarded retry cannot duplicate it.
            const int retryWaitMs = std::max(250, intEnv("BAMBU_NATIVE_CONTROL_RETRY_MS", 1000));
            outputLine("native_retry reason=control_cert_bootstrap wait_ms=" + std::to_string(retryWaitMs));
            std::this_thread::sleep_for(std::chrono::milliseconds(retryWaitMs));
            api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
            const int retryUpdate = api.updateCert(agent);
            outputLine("native_update_cert result=" + std::to_string(retryUpdate) + " stage=control_retry");
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
            authorizeDispatch(2);
            result = api.sendMessageToPrinter(agent, serial, commandJson, qos, flag);
        }
        outputLine("native_command result=" + std::to_string(result));
        destroyAgent();
        exitNow(result == 0 ? 0 : 20);
    }

    std::this_thread::sleep_for(std::chrono::seconds(3));
    }

    BBL::PrintParams params;
    const std::string projectName = envOr("BAMBU_NATIVE_PROJECT_NAME", "native-mcp-job");
    params.dev_id = serial;
    params.task_name = envOr("BAMBU_NATIVE_TASK_NAME", projectName);
    params.project_name = projectName;
    params.preset_name = envOr("BAMBU_NATIVE_PRESET_NAME", projectName + "_plate_1");
    params.filename = file;
    params.dst_file = envOr("BAMBU_NATIVE_DST_FILE");
    params.config_filename = envOr("BAMBU_NATIVE_CONFIG_FILE", file);
    params.plate_index = intEnv("BAMBU_NATIVE_PLATE_INDEX", 1);
    params.nozzle_mapping = envOr("BAMBU_NATIVE_NOZZLE_MAPPING");
    params.ams_mapping = envOr("BAMBU_NATIVE_AMS_MAPPING");
    params.ams_mapping2 = envOr("BAMBU_NATIVE_AMS_MAPPING2");
    params.ams_mapping_info = envOr("BAMBU_NATIVE_AMS_MAPPING_INFO");
    params.nozzles_info = envOr("BAMBU_NATIVE_NOZZLES_INFO");
    params.connection_type = cloud ? "cloud" : "lan";
    params.dev_ip = host;
    params.use_ssl_for_ftp = true;
    params.use_ssl_for_mqtt = true;
    params.username = "bblp";
    params.password = token;
    params.task_bed_leveling = boolEnv("BAMBU_NATIVE_BED_LEVELING", true);
    params.task_flow_cali = boolEnv("BAMBU_NATIVE_FLOW_CALIBRATION", true);
    params.task_vibration_cali = boolEnv("BAMBU_NATIVE_VIBRATION_CALIBRATION", true);
    params.task_layer_inspect = boolEnv("BAMBU_NATIVE_LAYER_INSPECT", false);
    params.task_record_timelapse = boolEnv("BAMBU_NATIVE_TIMELAPSE", false);
    params.task_timelapse_use_internal = boolEnv("BAMBU_NATIVE_TIMELAPSE_INTERNAL", false);
    params.task_use_ams = boolEnv("BAMBU_NATIVE_USE_AMS", true);
    params.task_bed_type = cloud ? envOr("BAMBU_NATIVE_BED_TYPE", "textured_plate") : bedTypeForNative(envOr("BAMBU_NATIVE_BED_TYPE", "textured_plate"));
    params.auto_bed_leveling = intEnv("BAMBU_NATIVE_AUTO_BED_LEVELING", 0);
    params.auto_flow_cali = intEnv("BAMBU_NATIVE_AUTO_FLOW_CALI", 0);
    params.auto_offset_cali = intEnv("BAMBU_NATIVE_AUTO_OFFSET_CALI", 0);
    params.extruder_cali_manual_mode = intEnv("BAMBU_NATIVE_EXTRUDER_CALI_MANUAL_MODE", -1);
    params.task_ext_change_assist = boolEnv("BAMBU_NATIVE_EXTERNAL_CHANGE_ASSIST", false);
    params.try_emmc_print = boolEnv("BAMBU_NATIVE_TRY_EMMC_PRINT", true);
    params.print_type = envOr("BAMBU_NATIVE_PRINT_TYPE", "from_normal");

    bool cloudDispatchChecked = false;
    const BBL::OnUpdateStatusFn update = [&](int status, int code, std::string message) {
        // The cloud upload can outlive preflight. Recheck at the sending stage.
        if (cloud && status == 3 && !cloudDispatchChecked) {
            cloudDispatchChecked = true;
            authorizeDispatch(2);
        }
        outputLine("native_update status=" + std::to_string(status) + " code=" +
                   std::to_string(code) + (cloud ? "" : " msg=" + message));
        if (cloud && code < 0) outputLine(cloudFailureSummary(status, code, message));
    };
    const BBL::WasCancelledFn cancel = []() { return false; };
    const auto startAuthorizedPrint = [&](int attempt) {
        authorizeDispatch(attempt);
        return api.startLocalPrint(agent, params, update, cancel);
    };
    if (cloud) {
        const auto startCloud = requiredSymbol<StartSendGcodeToSdcardFn>(api.handle, "bambu_network_start_print");
        authorizeDispatch(1);
        // The parent verifies physical start from fresh telemetry separately.
        const std::function<bool(int, std::string)> wait = [](int, std::string) { return true; };
        result = startCloud(agent, params, update, cancel, wait);
    } else if (uploadOnly) {
        const std::function<bool(int, std::string)> wait = [](int, std::string) { return false; };
        result = api.startSendGcodeToSdcard(agent, params, update, cancel, wait);
    } else {
        result = startAuthorizedPrint(1);
        if (result == -4030) {
            // The first encrypted publish can be the plug-in's certificate
            // bootstrap. Keep the agent alive long enough for the printer's
            // response to populate device_pub_key_map, then retry exactly once.
            const int retryWaitSeconds = intEnv("BAMBU_NATIVE_CERT_RETRY_SECONDS", 8);
            outputLine("native_retry reason=cert_bootstrap wait_seconds=" + std::to_string(retryWaitSeconds));
            std::this_thread::sleep_for(std::chrono::seconds(std::max(1, retryWaitSeconds)));
            api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
            const int retryUpdate = api.updateCert(agent);
            outputLine("native_update_cert result=" + std::to_string(retryUpdate) + " stage=retry");
            std::this_thread::sleep_for(std::chrono::seconds(3));
            result = startAuthorizedPrint(2);
        }
    }
    outputLine(std::string(uploadOnly ? "native_upload" : "native_print") + " result=" + std::to_string(result));
    // A one-shot print helper has finished dispatch. Plug-in worker teardown can
    // crash after acceptance; let the OS reclaim it without changing that result.
    // outputLine flushes the receipt before exiting. Upload/control paths retain
    // their existing cleanup, and no dispatched print is replayed here.
    if (!uploadOnly) exitNow(result == 0 ? 0 : 20);
    destroyAgent();
    exitNow(result == 0 ? 0 : 20);
}

} // namespace

// File service only: this library exposes the Studio storage tunnel and does
// not load the networking agent or any print/control entry point.
void runFileService() {
    const std::string plugin = envOr("BAMBU_NATIVE_PLUGIN", defaultPluginPath());
    const auto slash = plugin.find_last_of('/');
#if defined(__APPLE__)
    std::string source = plugin.substr(0, slash + 1) + "libBambuSource.dylib";
    if (envOr("BAMBU_NATIVE_PLUGIN").empty() && !isRegularFile(source))
        source = homeDir() + "/Library/Application Support/BambuStudio/plugins/libBambuSource.dylib";
#else
    const std::string source = plugin.substr(0, slash + 1) + "libBambuSource.so";
#endif
    void *library = dlopen(source.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!library) throw std::runtime_error("could not load Bambu file-service library");
    const auto symbol = [library](const char *name) {
        void *value = dlsym(library, name);
        if (!value) throw std::runtime_error(std::string("missing file-service symbol: ") + name);
        return value;
    };
    struct Sample { int track; int size; int flags; void *buffer; uint64_t decodeTime; };
    auto create = reinterpret_cast<int (*)(void **, const char *)>(symbol("Bambu_Create"));
    auto open = reinterpret_cast<int (*)(void *)>(symbol("Bambu_Open"));
    auto start = reinterpret_cast<int (*)(void *, int)>(symbol("Bambu_StartStreamEx"));
    auto send = reinterpret_cast<int (*)(void *, int, const char *, int)>(symbol("Bambu_SendMessage"));
    auto read = reinterpret_cast<int (*)(void *, Sample *)>(symbol("Bambu_ReadSample"));
    auto close = reinterpret_cast<void (*)(void *)>(symbol("Bambu_Close"));
    auto destroy = reinterpret_cast<void (*)(void *)>(symbol("Bambu_Destroy"));
    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    if (host.empty() || token.empty() || host.find_first_of("/?&#\r\n") != std::string::npos ||
        token.find_first_of("&?#\r\n") != std::string::npos)
        throw std::runtime_error("invalid file-service host or access code");
    void *handle = nullptr;
    const auto check = [](int result, const char *stage) {
        if (result != 0) throw std::runtime_error(std::string("file-service ") + stage + " failed: " + std::to_string(result));
    };
    const auto retry = [&check](auto operation, const char *stage) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        int result;
        while ((result = operation()) == 2) {
            if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("file-service operation timed out");
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        check(result, stage);
    };
    const std::string url = "bambu:///local/" + host + "?port=6000&user=bblp&passwd=" + token;
    check(create(&handle, url.c_str()), "create");
    check(open(handle), "open");
    constexpr int control = 0x3001;
    constexpr size_t maxFrame = 4 * 1024 * 1024;
    retry([&]() { return start(handle, control); }, "handshake");
    std::atomic<bool> stopping{false};
    std::thread reader([&]() {
        try {
            const char *digits = "0123456789abcdef";
            while (!stopping) {
                Sample sample{};
                const int result = read(handle, &sample);
                if (result == 2) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
                check(result, "read");
                if (sample.size < 0 || static_cast<size_t>(sample.size) > maxFrame || (!sample.buffer && sample.size))
                    throw std::runtime_error("invalid file-service sample size");
                const auto *bytes = static_cast<const unsigned char *>(sample.buffer);
                std::string hex;
                hex.reserve(sample.size * 2);
                for (int i = 0; i < sample.size; ++i) { hex += digits[bytes[i] >> 4]; hex += digits[bytes[i] & 15]; }
                outputLine("native_file_sample=" + hex);
            }
        } catch (const std::exception &error) {
            std::cerr << "native_error=" << error.what() << std::endl;
            exitNow(1);
        }
    });
    outputLine("native_file_ready=1");
    try {
        std::string line;
        while (std::getline(std::cin, line)) {
            const std::string prefix = "native_file_send=";
            if (line.compare(0, prefix.size(), prefix) != 0 || line.size() > prefix.size() + maxFrame * 2 ||
                (line.size() - prefix.size()) % 2 != 0) throw std::runtime_error("invalid file-service frame");
            const auto digit = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                throw std::runtime_error("invalid file-service hex");
            };
            std::string data;
            for (size_t i = prefix.size(); i < line.size(); i += 2) data += static_cast<char>((digit(line[i]) << 4) | digit(line[i + 1]));
            retry([&]() { return send(handle, control, data.data(), static_cast<int>(data.size())); }, "send");
        }
    } catch (...) {
        // Avoid a joinable-thread destructor before main reports the error.
        stopping = true;
        reader.join();
        throw;
    }
    stopping = true;
    reader.join();
    close(handle);
    destroy(handle);
    exitNow(0);
}

// Load the plug-in and resolve every required symbol without any network
// access. On Linux also load the file-tunnel library the plug-in opens from its
// own directory, so missing system libraries surface at setup time.
void runPluginCheck(const NativeApi &) {
#if !defined(__APPLE__)
    const std::string plugin = envOr("BAMBU_NATIVE_PLUGIN", defaultPluginPath());
    // Resolve beside the plug-in, never through the system library path.
    const std::string::size_type slash = plugin.find_last_of('/');
    const std::string source = (slash == std::string::npos ? std::string("./") : plugin.substr(0, slash + 1)) + "libBambuSource.so";
    void *handle = dlopen(source.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        const char *error = dlerror();
        throw std::runtime_error("could not load Bambu tunnel library: " + source + (error ? std::string(": ") + error : std::string()));
    }
    dlclose(handle);
#endif
    outputLine("plugin=ok");
}

// Read account/device access through the same cloud API used by Studio.
// The caller supplies a private copy of its authenticated configuration; this
// probe never uploads, dispatches a job, or changes the Studio session.
namespace {
void *createCloudAgent(const NativeApi &api) {
    const auto loggedIn = requiredSymbol<bool (*)(void *)>(api.handle, "bambu_network_is_user_login");
    const std::string directory = envOr("BAMBU_NATIVE_CONFIG_DIR");
    const std::string serial = envOr("BAMBU_NATIVE_SERIAL");
    if (directory.empty() || serial.empty()) throw std::runtime_error("cloud probe requires a private configuration directory and printer serial");
    void *agent = api.createAgent(directory);
    if (!agent) throw std::runtime_error("cloud agent creation failed");
    const auto check = [](int result, const char *stage) {
        if (result != 0) throw std::runtime_error(std::string("cloud ") + stage + " failed: " + std::to_string(result));
    };
    // Follow Studio's agent setup order: configuration, HTTP log, certificates,
    // extra headers, region. init_log is required: without it the plug-in's own
    // account requests return HTTP 401 although its cloud MQTT session works.
    check(api.setConfigDir(agent, directory), "configuration");
    check(api.initLog(agent), "log");
    check(api.setCertFile(agent, defaultCertDir(), envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer")), "certificates");
    // Studio sends only its X-BBL client identity here. The plug-in adds extra
    // headers to every request, including presigned storage uploads, where an
    // Authorization header conflicts with the URL's own signature.
    const auto headers = requiredSymbol<int (*)(void *, std::map<std::string, std::string>)>(api.handle, "bambu_network_set_extra_http_header");
    check(headers(agent, {{"X-BBL-Client-Type", "slicer"}, {"X-BBL-Client-Name", "BambuStudio"},
        {"X-BBL-Client-Version", envOr("BAMBU_NATIVE_STUDIO_VERSION")}, {"X-BBL-OS-Type", "macos"},
        {"X-BBL-Device-ID", envOr("BAMBU_NATIVE_STUDIO_DEVICE_ID")}, {"X-BBL-Language", "en"}}), "headers");
    check(api.setCountryCode(agent, envOr("BAMBU_NATIVE_COUNTRY", "US")), "region");
    check(api.setQueueOnMain(agent, [](std::function<void()> callback) { if (callback) callback(); }), "callbacks");
    auto capabilities = std::make_shared<LocalConnectionState>();
    const auto send = requiredSymbol<SendMessageToPrinterFn>(api.handle, "bambu_network_send_message");
    check(api.setPrinterConnected(agent, [agent, serial, send, &api](std::string devId) {
        if (devId != serial) return;
        const int result = send(agent, serial, R"({"pushing":{"sequence_id":"1","command":"pushall","version":1,"push_target":1}})", 0, 0);
        outputLine("native_cloud_capability_request=" + std::to_string(result));
        api.installDeviceCert(agent, serial, false);
    }), "printer callback");
    check(api.setMessage(agent, [capabilities, serial, agent, &api](std::string devId, std::string message) {
        if ((devId.empty() || devId == serial) && message == "wait_info") api.installDeviceCert(agent, serial, false);
        // The plug-in parses the device security flags from this same report.
        // This is a readiness signal, not a replacement for the parent's
        // independent fresh identity, hardware and job checks at dispatch.
        static const std::regex flags(R"re("fun"\s*:\s*("[0-9a-fA-FxX]+"|[0-9]+)\s*[,}])re");
        if (devId != serial || message.find("\"print\"") == std::string::npos || !std::regex_search(message, flags)) return;
        std::lock_guard<std::mutex> lock(capabilities->mutex);
        capabilities->resolved = true;
        capabilities->cv.notify_all();
    }), "device callback");
    check(api.start(agent), "startup");
    const bool authenticated = loggedIn(agent);
    outputLine(std::string("native_cloud_session=") + (authenticated ? "present" : "missing"));
    if (!authenticated) exitNow(1);
    check(api.updateCert(agent), "app certificate update");
    const auto connectServer = requiredSymbol<int (*)(void *)>(api.handle, "bambu_network_connect_server");
    const auto serverCallback = requiredSymbol<int (*)(void *, std::function<void(int, int)>)>(api.handle, "bambu_network_set_on_server_connected_fn");
    auto connection = std::make_shared<LocalConnectionState>();
    check(serverCallback(agent, [connection](int code, int reason) {
        outputLine("native_cloud_server code=" + std::to_string(code) + " reason=" + std::to_string(reason));
        std::lock_guard<std::mutex> lock(connection->mutex); connection->resolved = true; connection->ok = code == 0 && reason == 0; connection->cv.notify_all();
    }), "server callback");
    check(connectServer(agent), "connect");
    { std::unique_lock<std::mutex> lock(connection->mutex);
      if (!connection->cv.wait_for(lock, std::chrono::seconds(15), [&]() { return connection->resolved; }) || !connection->ok)
          throw std::runtime_error("cloud connection failed before dispatch; no job was submitted"); }
    const auto select = requiredSymbol<int (*)(void *, std::string)>(api.handle, "bambu_network_set_user_selected_machine");
    const auto subscribe = requiredSymbol<int (*)(void *, std::vector<std::string>)>(api.handle, "bambu_network_add_subscribe");
    const auto startSubscription = requiredSymbol<int (*)(void *, std::string)>(api.handle, "bambu_network_start_subscribe");
    check(select(agent, serial), "select printer");
    check(subscribe(agent, {serial}), "subscribe printer");
    check(startSubscription(agent, "app"), "start subscription");
    { std::unique_lock<std::mutex> lock(capabilities->mutex);
      if (!capabilities->cv.wait_for(lock, std::chrono::seconds(15), [&]() { return capabilities->resolved; })) {
          outputLine("native_cloud_device=timeout");
          throw std::runtime_error("cloud printer capability report timed out before dispatch; no job was submitted"); } }
    outputLine("native_cloud_device=ready");
    return agent;
}
} // namespace

void runCloudProbe(const NativeApi &api) {
    void *agent = createCloudAgent(api);
    const auto getDevices = requiredSymbol<int (*)(void *, unsigned int *, std::string *)>(api.handle, "bambu_network_get_user_print_info");
    unsigned int http = 0;
    std::string body;
    const int result = getDevices(agent, &http, &body);
    // Private probe output is consumed locally, never forwarded as a tool log.
    const std::string responsePath = envOr("BAMBU_NATIVE_CONFIG_DIR") + "/cloud-probe-response.json";
    { std::ofstream response(responsePath); response << body; }
    chmod(responsePath.c_str(), 0600);
    outputLine("native_cloud_query result=" + std::to_string(result) + " http=" + std::to_string(http));
    if (result != 0 || http != 200) exitNow(1);
    // Account lookup does not exercise the app-signing gate. Minting a camera
    // URL does, without uploading a model or submitting a print. Never emit the
    // URL: it contains credentials. An error string is not a successful URL.
    const auto getCamera = requiredSymbol<int (*)(void *, std::string, std::function<void(std::string)>)>(api.handle, "bambu_network_get_camera_url");
    auto signing = std::make_shared<LocalConnectionState>();
    const int cameraResult = getCamera(agent, envOr("BAMBU_NATIVE_SERIAL"), [signing](std::string url) {
        std::lock_guard<std::mutex> lock(signing->mutex);
        signing->ok = url.rfind("bambu:///", 0) == 0;
        signing->resolved = true;
        signing->cv.notify_all();
    });
    std::unique_lock<std::mutex> lock(signing->mutex);
    if (cameraResult != 0 || !signing->cv.wait_for(lock, std::chrono::seconds(10), [&]() { return signing->resolved; }) || !signing->ok) {
        outputLine("native_cloud_signing=rejected");
        exitNow(1);
    }
    outputLine("native_cloud_signing=verified");
    exitNow(0);
}

int main(int argc, char **argv) {
    try {
        if (argc == 2 && std::strcmp(argv[1], "--file-service") == 0) runFileService();
        const bool pluginCheck = argc == 2 && std::strcmp(argv[1], "--check-plugin") == 0;
        const bool probe = argc == 2 && std::strcmp(argv[1], "--probe") == 0;
        const bool mqttProbe = argc == 2 && std::strcmp(argv[1], "--probe-mqtt") == 0;
        const bool cloudProbe = argc == 2 && std::strcmp(argv[1], "--probe-cloud") == 0;
        const bool print = argc == 2 && std::strcmp(argv[1], "--print-authorized") == 0;
        const bool cloudPrint = argc == 2 && std::strcmp(argv[1], "--cloud-print-authorized") == 0;
        const bool upload = argc == 2 && std::strcmp(argv[1], "--upload") == 0;
        const bool command = argc == 2 && std::strcmp(argv[1], "--command") == 0;
        const bool authorizedCommand = argc == 2 && std::strcmp(argv[1], "--command-authorized") == 0;
        if (!pluginCheck && !probe && !mqttProbe && !cloudProbe && !print && !cloudPrint && !upload && !command && !authorizedCommand) {
            std::cerr << "usage: bambu-native-print --check-plugin|--probe|--probe-mqtt|--print-authorized|--upload|--command|--command-authorized" << std::endl;
            return 2;
        }
#if defined(__APPLE__)
        if (cloudProbe || cloudPrint) configureCloudIdentity(
            envOr("SLICER_PATH", "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"),
            envOr("BAMBU_NATIVE_PLUGIN", defaultPluginPath()));
#endif
        NativeApi api = loadApi();
        if (pluginCheck) runPluginCheck(api);
        if (probe) runProbe(api);
        if (mqttProbe) runMqttProbe(api);
        if (cloudProbe) runCloudProbe(api);
        if (print) runOperation(api, NativeOperation::Print);
        if (cloudPrint) runOperation(api, NativeOperation::CloudPrint);
        if (upload) runOperation(api, NativeOperation::Upload);
        if (command) runOperation(api, NativeOperation::Command);
        if (authorizedCommand) runOperation(api, NativeOperation::AuthorizedCommand);
        exitNow(0);
    } catch (const std::exception &error) {
        std::cerr << "native_error=" << error.what() << std::endl;
        exitNow(1);
    }
}
