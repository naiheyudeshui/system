# spring-todo-demo

用 **Spring Boot** 写的最小 Todo API，**无前端**。  
适合从 C++ 角度理解：分层 + 构造函数依赖注入（IoC）。

## 依赖关系（重点）

```text
TodoController  --依赖-->  TodoService  --依赖-->  TodoRepository
                                                      ↑
                                         InMemoryTodoRepository（实现）
```

对应 C++ 手工装配：

```cpp
InMemoryTodoRepository repo;
TodoService service(repo);
TodoController controller(service);
```

Spring 在启动时自动完成上述装配。

## 环境要求

- JDK 17+
- Maven 3.8+（或 IDE 自带 Maven）

## 启动

在项目根目录 `spring-todo-demo` 下执行：

```bash
mvn spring-boot:run
```

看到启动完成后，服务在：`http://localhost:8080`

## 用 curl 验证（无需浏览器页面）

**1. 创建任务**

```bash
curl -X POST http://localhost:8080/todos ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"买牛奶\"}"
```

（Linux/macOS 把 `^` 换成 `\`，JSON 外层用单引号更方便。）

**2. 列出任务**

```bash
curl http://localhost:8080/todos
```

**3. 标记完成（把 id 换成返回的数字）**

```bash
curl -X POST http://localhost:8080/todos/1/done
```

## 源码目录

```text
src/main/java/com/example/todo/
  TodoApplication.java          # main / 启动容器
  model/Todo.java               # 数据
  repository/TodoRepository.java
  repository/InMemoryTodoRepository.java
  service/TodoService.java      # 业务
  web/TodoController.java       # HTTP 入口
  web/CreateTodoRequest.java
src/main/resources/
  application.properties
```

## 和教材概念的对应

| 概念 | 在本项目里 |
|------|------------|
| 分层 | web → service → repository |
| 依赖注入 | 构造函数参数由 Spring 注入 |
| 面向接口 | Service 依赖 `TodoRepository`，不依赖内存实现类名 |
| Java EE/Web | 内嵌 Tomcat 收 HTTP；你写的是业务 Bean |
