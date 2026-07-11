# Based on the create-react-native-library C++ turbo-module template, with
# uniffi-bindgen-react-native additions: the generated JSI bindings and the
# Rust static library. Built directly by the app via react-native.config.js
# (cxxModuleCMakeListsPath) - this library has no Gradle project of its own.
cmake_minimum_required(VERSION 3.9.0)
project(WormholeRn)

set (CMAKE_VERBOSE_MAKEFILE ON)

# Resolve the uniffi-bindgen-react-native package root for its C++ headers.
# The package's exports map only exposes ".", so resolving "./package.json"
# (as the ubrn docs suggest) throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the
# entry point (<pkg>/typescript/dist/cjs/index.js) and walk up to the root.
execute_process(
    COMMAND node -p "require('path').resolve(require.resolve('uniffi-bindgen-react-native'), '..', '..', '..', '..')"
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT EXISTS "${UNIFFI_BINDGEN_PATH}/cpp/includes")
    message(FATAL_ERROR "Could not locate uniffi-bindgen-react-native package (got: '${UNIFFI_BINDGEN_PATH}')")
endif()

add_library(
    wormhole-rn    STATIC
    ../cpp/WormholeRnImpl.cpp
    ../cpp/wormhole-rn.cpp
    ../cpp/generated/wormhole_core.cpp
)

set_target_properties(
    wormhole-rn PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)

target_include_directories(
    wormhole-rn    PUBLIC
    ../cpp
    ../cpp/generated
    ${UNIFFI_BINDGEN_PATH}/cpp/includes
)

# The Rust engine, cross-compiled by `yarn ubrn:android` into jniLibs.
cmake_path(
  SET WORMHOLE_CORE_LIB
  ${CMAKE_CURRENT_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI}/libwormhole_core.a
  NORMALIZE
)
add_library(wormhole_core STATIC IMPORTED)
set_target_properties(wormhole_core PROPERTIES IMPORTED_LOCATION ${WORMHOLE_CORE_LIB})

target_link_libraries(
    wormhole-rn    jsi
    reactnative
    react_codegen_WormholeRnSpec
    wormhole_core
    log
)
