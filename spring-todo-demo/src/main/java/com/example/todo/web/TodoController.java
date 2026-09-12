package com.example.todo.web;

import com.example.todo.model.Todo;
import com.example.todo.service.TodoService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * HTTP 入口。类似把函数挂到 URL 上：
 *   GET  /todos
 *   POST /todos
 *   POST /todos/{id}/done
 *
 * Controller 依赖 Service；Service 依赖 Repository —— 全由 Spring 注入。
 */
@RestController
@RequestMapping("/todos")
public class TodoController {

    private final TodoService todoService;

    public TodoController(TodoService todoService) {
        this.todoService = todoService;
    }

    @GetMapping
    public List<Todo> list() {
        return todoService.list();
    }

    @PostMapping
    public Todo create(@RequestBody CreateTodoRequest request) {
        return todoService.create(request.getTitle());
    }

    @PostMapping("/{id}/done")
    public Todo markDone(@PathVariable Long id) {
        return todoService.markDone(id);
    }
}
