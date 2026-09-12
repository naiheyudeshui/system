package com.example.todo.repository;

import com.example.todo.model.Todo;

import java.util.List;
import java.util.Optional;

/**
 * 持久化抽象，类似 C++ 的纯虚接口。
 * Service 只依赖这个接口，不依赖具体用内存还是数据库。
 */
public interface TodoRepository {

    Todo save(Todo todo);

    List<Todo> findAll();

    Optional<Todo> findById(Long id);
}
