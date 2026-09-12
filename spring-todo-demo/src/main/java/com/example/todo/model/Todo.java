package com.example.todo.model;

/**
 * 任务数据，类似 C++ 的 struct / POD。
 */
public class Todo {

    private Long id;
    private String title;
    private boolean done;

    public Todo() {
    }

    public Todo(Long id, String title, boolean done) {
        this.id = id;
        this.title = title;
        this.done = done;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public boolean isDone() {
        return done;
    }

    public void setDone(boolean done) {
        this.done = done;
    }
}
