package com.example.todo.repository;

import com.example.todo.model.Todo;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 内存实现：用 Map 模拟数据库，方便上手，无需安装 MySQL。
 * @Repository 告诉 Spring：把这个类注册成 Bean，可供注入。
 */
@Repository
public class InMemoryTodoRepository implements TodoRepository {

    private final Map<Long, Todo> store = new ConcurrentHashMap<>();
    private final AtomicLong seq = new AtomicLong(1);

    @Override
    public Todo save(Todo todo) {
        if (todo.getId() == null) {
            todo.setId(seq.getAndIncrement());
        }
        store.put(todo.getId(), todo);
        return todo;
    }

    @Override
    public List<Todo> findAll() {
        return new ArrayList<>(store.values());
    }

    @Override
    public Optional<Todo> findById(Long id) {
        return Optional.ofNullable(store.get(id));
    }
}
