package com.example.todo.service;

import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/**
 * 业务层。类似 C++：
 *   explicit TodoService(TodoRepository& repo) : repo_(repo) {}
 * Spring 通过构造函数注入 TodoRepository 的实现（InMemoryTodoRepository）。
 */
@Service
public class TodoService {

    private final TodoRepository repository;

    public TodoService(TodoRepository repository) {
        this.repository = repository;
    }

    public Todo create(String title) {
        if (title == null || title.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "title must not be blank");
        }
        Todo todo = new Todo();
        todo.setTitle(title.trim());
        todo.setDone(false);
        return repository.save(todo);
    }

    public List<Todo> list() {
        return repository.findAll();
    }

    public Todo markDone(Long id) {
        Todo todo = repository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "todo not found: " + id));
        todo.setDone(true);
        return repository.save(todo);
    }
}
