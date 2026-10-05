plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

android {
    namespace = "local.studykb"
    compileSdk = 35

    defaultConfig {
        applicationId = "local.studykb"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

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
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(assembleStudyRuntime)
}
