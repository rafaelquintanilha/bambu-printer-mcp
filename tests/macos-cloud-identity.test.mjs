import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

test('macOS signing identity is restricted to the selected plug-in and helper, including symlink paths', {skip:process.platform!=='darwin'}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bambu-identity-test-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=fileURLToPath(new URL('../native/bambu-native-print.cpp',import.meta.url));
  const pluginSource=path.join(directory,'plugin.cpp'), plugin=path.join(directory,'plugin.dylib');
  const driver=path.join(directory,'driver.cpp'), binary=path.join(directory,'helper');
  const identitySource=path.join(directory,'identity.cpp'), identity=path.join(directory,'identity.dylib');
  const probeFunction=`
extern "C" int signature_path(const char *filename, char *buffer, size_t capacity) {
  CFURLRef url=CFURLCreateFromFileSystemRepresentation(nullptr,(const UInt8*)filename,strlen(filename),false);
  SecStaticCodeRef code=nullptr; CFURLRef found=nullptr;
  OSStatus result=SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code);
  if(!result) result=SecCodeCopyPath(code,kSecCSDefaultFlags,&found);
  if(!result && !CFURLGetFileSystemRepresentation(found,true,(UInt8*)buffer,capacity))result=-1;
  if(found)CFRelease(found);if(code)CFRelease(code);CFRelease(url);
  return result;
}`;
  await fs.writeFile(pluginSource,`#include <Security/Security.h>\n#include <cstring>\n${probeFunction}`);
  await fs.writeFile(identitySource,`
#include ${JSON.stringify(fileURLToPath(new URL('../native/bambu-cloud-identity.cpp',import.meta.url)))}
extern "C" void test_config(const char* host,const char* plugin,const char* studio) {
 cloudIdentityHost=canonicalPath(host);cloudIdentityPlugin=canonicalPath(plugin);
 const std::string other=canonicalPath(studio);
 cloudIdentityStudio=CFURLCreateFromFileSystemRepresentation(nullptr,(const UInt8*)other.data(),other.size(),false);
}
`);
  await fs.writeFile(driver,`
#include <Security/Security.h>
#include <limits.h>
#define main adapter_main
#include ${JSON.stringify(source)}
#undef main
extern "C" void test_config(const char*,const char*,const char*);
std::string canonicalPath(const std::string &s){char p[PATH_MAX];if(!realpath(s.c_str(),p))throw std::runtime_error("path");return p;}
${probeFunction}
int main(int argc,char**argv) {
 try {
  if(argc==2){configureCloudIdentity(envOr("SLICER_PATH"),envOr("BAMBU_NATIVE_PLUGIN"));return 0;}
  if(argc!=5)return 2;
  const std::string self=canonicalPath(argv[0]), other=canonicalPath(argv[2]);
  test_config(argv[0],argv[1],argv[2]);
  void* plugin=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
  const auto read=requiredSymbol<int (*)(const char*,char*,size_t)>(plugin,"signature_path");
  char result[PATH_MAX];
  if(read(argv[3],result,sizeof(result)) || canonicalPath(result)!=other)return 3;
  if(read(argv[4],result,sizeof(result)) || canonicalPath(result)!=canonicalPath(argv[4]))return 4;
  if(signature_path(argv[3],result,sizeof(result)) || canonicalPath(result)!=self)return 5;
  return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<std::endl;return 1;}
}`);
  const compile=args=>{
    const r=spawnSync(process.env.CXX||'c++',['-std=c++17',...args,'-framework','Security','-framework','CoreFoundation'],{encoding:'utf8',timeout:60000});
    assert.equal(r.status,0,r.stderr);
  };
  compile(['-dynamiclib',pluginSource,'-o',plugin]);
  compile(['-dynamiclib',identitySource,'-o',identity,'-Wl,-install_name,'+identity]);
  compile([driver,'-o',binary,'-ldl','-pthread',identity]);
  const helperAlias=path.join(directory,'helper-alias'), pluginAlias=path.join(directory,'plugin-alias.dylib');
  await fs.symlink(binary,helperAlias);await fs.symlink(plugin,pluginAlias);
  const scoped=spawnSync(helperAlias,[pluginAlias,process.execPath,helperAlias,plugin],{encoding:'utf8',timeout:10000});
  assert.equal(scoped.status,0,scoped.stderr);
  const invalid=spawnSync(binary,['verify'],{env:{...process.env,SLICER_PATH:binary,BAMBU_NATIVE_PLUGIN:plugin},encoding:'utf8',timeout:10000});
  assert.equal(invalid.status,1);
  assert.match(invalid.stderr,/unmodified Bambu-signed Studio.*no job was submitted/);
  const missing=spawnSync(binary,['verify'],{env:{...process.env,SLICER_PATH:path.join(directory,'missing'),BAMBU_NATIVE_PLUGIN:plugin},encoding:'utf8',timeout:10000});
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/existing Studio executable and networking plug-in/);
});
