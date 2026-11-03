#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <mach-o/dyld.h>
#include <dlfcn.h>
#include <limits.h>
#include <cstdlib>
#include <stdexcept>
#include <string>

// The macOS networking plug-in gates signing on the caller's Studio identity.
// A standalone helper has no Bambu publisher certificate. Supply the installed,
// signature-verified Studio identity only for that plug-in's inspection of this
// helper. This neither changes files nor extracts a private key; the unmodified
// plug-in still performs signing, cloud authentication and device authorization.
static std::string cloudIdentityHost;
static std::string cloudIdentityPlugin;
static CFURLRef cloudIdentityStudio = nullptr;

static std::string canonicalPath(const std::string &path) {
    char resolved[PATH_MAX];
    if (!realpath(path.c_str(), resolved)) throw std::runtime_error("cloud signing requires an existing Studio executable and networking plug-in");
    return resolved;
}

static CFURLRef verifiedBambuBinary(const std::string &path, CFStringRef requirementText) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr,
        reinterpret_cast<const UInt8 *>(path.data()), path.size(), false);
    SecStaticCodeRef code = nullptr;
    SecRequirementRef requirement = nullptr;
    OSStatus result = url ? SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) : errSecParam;
    if (result == errSecSuccess) result = SecRequirementCreateWithString(requirementText, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    if (result != errSecSuccess) {
        if (url) CFRelease(url);
        throw std::runtime_error("cloud signing requires unmodified Bambu-signed Studio and networking plug-in files (signature error " + std::to_string(result) + "); no job was submitted");
    }
    return url;
}

void configureCloudIdentity(const std::string &studioPath, const std::string &pluginPath) {
    const std::string studio = canonicalPath(studioPath);
    const std::string plugin = canonicalPath(pluginPath);
    CFURLRef studioURL = verifiedBambuBinary(studio,
        CFSTR("anchor apple generic and identifier \"com.bambulab.bambu-studio\" and certificate leaf[subject.OU] = \"T3UBR9Y3B2\""));
    try {
        CFURLRef pluginURL = verifiedBambuBinary(plugin,
            CFSTR("anchor apple generic and identifier \"libbambu_networking\" and certificate leaf[subject.OU] = \"T3UBR9Y3B2\""));
        CFRelease(pluginURL);
        char executable[PATH_MAX];
        uint32_t size = sizeof(executable);
        if (_NSGetExecutablePath(executable, &size) != 0) throw std::runtime_error("cannot resolve cloud helper executable");
        cloudIdentityHost = canonicalPath(executable);
        cloudIdentityPlugin = plugin;
        cloudIdentityStudio = studioURL;
    } catch (...) { CFRelease(studioURL); throw; }
}

static OSStatus studioIdentityForPlugin(CFURLRef path, SecCSFlags flags, SecStaticCodeRef *code) {
    Dl_info caller{};
    char target[PATH_MAX];
    char resolvedTarget[PATH_MAX];
    char resolvedCaller[PATH_MAX];
    if (cloudIdentityStudio && path &&
        dladdr(__builtin_return_address(0), &caller) && caller.dli_fname &&
        realpath(caller.dli_fname, resolvedCaller) && cloudIdentityPlugin == resolvedCaller &&
        CFURLGetFileSystemRepresentation(path, true, reinterpret_cast<UInt8 *>(target), sizeof(target)) &&
        realpath(target, resolvedTarget) && cloudIdentityHost == resolvedTarget) {
        return SecStaticCodeCreateWithPath(cloudIdentityStudio, flags, code);
    }
    return SecStaticCodeCreateWithPath(path, flags, code);
}

__attribute__((used)) static const struct { const void *replacement; const void *original; }
    cloudIdentityInterpose __attribute__((section("__DATA,__interpose"))) = {
        reinterpret_cast<const void *>(studioIdentityForPlugin),
        reinterpret_cast<const void *>(SecStaticCodeCreateWithPath)
    };
