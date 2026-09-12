package com.example.todo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 程序入口，类似 C++ 的 main，但由 Spring Boot 启动容器：
 * 扫描并创建 Bean，按构造函数完成依赖注入，再启动内嵌 Web 服务器。
 */
@SpringBootApplication
public class TodoApplication {

    public static void main(String[] args) {
        SpringApplication.run(TodoApplication.class, args);
    }
}
