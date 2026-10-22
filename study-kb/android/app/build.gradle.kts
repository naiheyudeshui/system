plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

val contractV2 = providers.gradleProperty("contractV2").orNull == "true"
val buildPythonPath = System.getenv("STUDY_BUILD_PYTHON") ?: "python"
val contractWheels = rootProject.layout.buildDirectory.dir("contract-wheels").get().asFile

android {
    namespace = "local.studykb"
    compileSdk = 35

    defaultConfig {
        applicationId = "local.studykb"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        if (contractV2) {
            applicationIdSuffix = ".contractv2"
            versionNameSuffix = "-contract-v2"
        }
        buildConfigField("boolean", "CONTRACT_V2", contractV2.toString())
        buildConfigField("int", "SERVER_PORT", if (contractV2) "18033" else "8033")
        manifestPlaceholders["appLabel"] = if (contractV2) "学习库 · 重构测试" else "@string/app_name"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

chaquopy {
    defaultConfig {
        // The build machine has Python 3.14. Chaquopy 17 can embed that same
        // version, and the study server only needs 3.10+ syntax.
        version = "3.14"
        if (contractV2) {
            buildPython(buildPythonPath)
            pip {
                options("--no-index", "--find-links", contractWheels.absolutePath)
                install("-r", rootProject.file("requirements-contract-android.txt").absolutePath)
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.activity:activity:1.9.3")
}

configurations.configureEach {
    resolutionStrategy.eachDependency {
        if (requested.group == "org.jetbrains.kotlin" && requested.name.startsWith("kotlin-stdlib")) {
            useVersion("1.8.22")
            because("AndroidX pulls an older kotlin-stdlib-jdk8 that duplicates classes")
        }
    }
}

val assembleStudyRuntime = tasks.register<Exec>("assembleStudyRuntime") {
    val python = System.getenv("STUDY_BUILD_PYTHON") ?: "python"
    commandLine(python, rootProject.file("../tools/assemble_android_assets.py").absolutePath)
    environment("STUDY_CONTRACT_V2", if (contractV2) "1" else "0")
}

val prepareContractDependencies = tasks.register<Exec>("prepareContractDependencies") {
    onlyIf { contractV2 }
    environment("PYRSISTENT_SKIP_EXTENSION", "1")
    commandLine(buildPythonPath, "-m", "pip", "wheel", "--no-deps", "--no-cache-dir",
        "--no-binary", "pyrsistent", "--wheel-dir", contractWheels.absolutePath,
        "-r", rootProject.file("requirements-contract-android.txt").absolutePath)
}

tasks.matching { it.name.startsWith("install") && it.name.endsWith("PythonRequirements") }.configureEach {
    dependsOn(prepareContractDependencies)
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(assembleStudyRuntime)
}
